/**
 * Bridge-managed git workflow operations driven by per-app
 * `AppGitSettings`. Two entry points:
 *
 *   - `prepareBranch` — runs BEFORE a child agent spawns in an app's
 *     working tree. Honors `branchMode`: `current` is a no-op,
 *     `fixed` checks out (or creates) the configured branch, and
 *     `auto-create` puts the agent on a `claude/<task-id>` branch
 *     branched from the current HEAD.
 *
 *   - `autoCommitAndPush` — runs AFTER a child agent completes
 *     successfully. Honors `autoCommit` and `autoPush`. Both are
 *     opt-in; the defaults preserve historical "do nothing" behavior.
 *
 * Every git invocation uses `execFile` (no shell), short timeouts,
 * and a structured result. Failures are surfaced to the caller via
 * `{ ok: false, error }` rather than throwing — the spawn endpoint
 * surfaces them as 4xx; the lifecycle hook logs them and moves on.
 *
 * The taskId is sanitized into the auto-create branch name (the
 * canonical `t_YYYYMMDD_NNN` shape passes the regex unchanged).
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import type { AppGitSettings } from "./apps";

const execFileP = promisify(execFile);

const SHORT_TIMEOUT_MS = 5_000;
const PUSH_TIMEOUT_MS = 60_000;
const AUTO_BRANCH_PREFIX = "claude/";

export interface GitOpResult {
  ok: boolean;
  /** One-line human-readable summary, suitable for logs / toasts. */
  message: string;
  /** Stderr captured from a failing command, if any. */
  error?: string;
}

interface RunOpts {
  timeoutMs?: number;
}

async function runGit(
  cwd: string,
  args: string[],
  opts: RunOpts = {},
): Promise<{ ok: true; stdout: string } | { ok: false; stderr: string; code: number }> {
  try {
    const { stdout } = await execFileP("git", args, {
      cwd,
      timeout: opts.timeoutMs ?? SHORT_TIMEOUT_MS,
      windowsHide: true,
      maxBuffer: 1 << 20,
    });
    return { ok: true, stdout: stdout.toString() };
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stderr?: Buffer | string; code?: number };
    const stderr = typeof e.stderr === "string" ? e.stderr : e.stderr?.toString() ?? "";
    return { ok: false, stderr: stderr.trim() || (e.message ?? "git failed"), code: typeof e.code === "number" ? e.code : 1 };
  }
}

function isGitRepo(cwd: string): boolean {
  return existsSync(join(cwd, ".git"));
}

/**
 * Convert a task id (canonical or otherwise) into a git-branch-safe
 * suffix. We allow `[A-Za-z0-9._/-]` and replace the rest with `_`.
 * Empty input → `task`.
 */
export function sanitizeBranchSegment(raw: string): string {
  const cleaned = raw.replace(/[^A-Za-z0-9._/-]/g, "_").replace(/^[/.-]+/, "");
  return cleaned || "task";
}

async function branchExists(cwd: string, branch: string): Promise<boolean> {
  const r = await runGit(cwd, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]);
  return r.ok;
}

async function currentBranch(cwd: string): Promise<string | null> {
  const r = await runGit(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (!r.ok) return null;
  const name = r.stdout.trim();
  return name && name !== "HEAD" ? name : null;
}

/**
 * Prepare the working tree for a child agent according to `settings`.
 * Returns `ok: false` if a checkout / create fails so the caller can
 * abort the spawn before the child sees a half-prepared tree.
 *
 * `current` mode is a deliberate no-op — even an uninitialized repo
 * is fine, the agent might be the one to `git init` it.
 */
export async function prepareBranch(
  cwd: string,
  settings: AppGitSettings,
  taskId: string,
): Promise<GitOpResult> {
  if (settings.branchMode === "current") {
    return { ok: true, message: "branch policy: use current — no change" };
  }
  if (!isGitRepo(cwd)) {
    return { ok: false, message: `not a git repo: ${cwd}`, error: "missing .git" };
  }

  if (settings.branchMode === "fixed") {
    const branch = settings.fixedBranch.trim();
    if (!branch) {
      return { ok: false, message: "fixedBranch is required for branchMode=fixed" };
    }
    return checkoutOrCreate(cwd, branch);
  }

  if (settings.branchMode === "auto-create") {
    const branch = AUTO_BRANCH_PREFIX + sanitizeBranchSegment(taskId);
    return checkoutOrCreate(cwd, branch);
  }

  return { ok: false, message: `unsupported branchMode: ${settings.branchMode}` };
}

async function checkoutOrCreate(cwd: string, branch: string): Promise<GitOpResult> {
  const cur = await currentBranch(cwd);
  if (cur === branch) {
    return { ok: true, message: `already on ${branch}` };
  }
  const exists = await branchExists(cwd, branch);
  const args = exists ? ["checkout", branch] : ["checkout", "-b", branch];
  const r = await runGit(cwd, args);
  if (!r.ok) {
    return {
      ok: false,
      message: `git checkout ${branch} failed`,
      error: r.stderr || `exit ${r.code}`,
    };
  }
  return {
    ok: true,
    message: exists ? `checked out existing ${branch}` : `created and checked out ${branch}`,
  };
}

/**
 * Stage every change, commit with `message`, optionally push to the
 * tracked upstream. Returns `ok: true` even when there's nothing to
 * commit — that's a valid outcome (the child made no changes).
 *
 * Push without a configured upstream emits a warning result rather
 * than failing the run; the bridge has no way to know which remote
 * the operator prefers.
 */
export async function autoCommitAndPush(
  cwd: string,
  settings: AppGitSettings,
  message: string,
): Promise<GitOpResult> {
  if (!settings.autoCommit && !settings.autoPush) {
    return { ok: true, message: "auto-commit + auto-push disabled" };
  }
  if (!isGitRepo(cwd)) {
    return { ok: false, message: `not a git repo: ${cwd}`, error: "missing .git" };
  }

  // 1. stage
  const add = await runGit(cwd, ["add", "-A"]);
  if (!add.ok) {
    return { ok: false, message: "git add -A failed", error: add.stderr };
  }

  // 2. detect any staged changes — porcelain output is empty when none
  const diff = await runGit(cwd, ["diff", "--cached", "--name-only"]);
  if (diff.ok && diff.stdout.trim().length === 0) {
    if (settings.autoPush) {
      // No new local commits, but there may be unpushed ones from a
      // previous run — try the push anyway. Fail-soft.
      return tryPush(cwd);
    }
    return { ok: true, message: "no changes to commit" };
  }

  // 3. commit
  const commit = await runGit(cwd, [
    "commit",
    "-m",
    message,
    "-m",
    "Co-Authored-By: claude-bridge <noreply@claude-bridge.local>",
  ]);
  if (!commit.ok) {
    return { ok: false, message: "git commit failed", error: commit.stderr };
  }

  if (!settings.autoPush) {
    return { ok: true, message: "committed (auto-push disabled)" };
  }
  return tryPush(cwd);
}

async function tryPush(cwd: string): Promise<GitOpResult> {
  const r = await runGit(cwd, ["push"], { timeoutMs: PUSH_TIMEOUT_MS });
  if (!r.ok) {
    // Distinguish "no upstream" from real push failures.
    const msg = r.stderr.toLowerCase();
    if (msg.includes("no upstream") || msg.includes("set-upstream") || msg.includes("has no upstream branch")) {
      return {
        ok: false,
        message: "auto-push skipped: no upstream branch configured",
        error: r.stderr,
      };
    }
    return { ok: false, message: "git push failed", error: r.stderr };
  }
  return { ok: true, message: "committed + pushed" };
}
