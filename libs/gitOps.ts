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
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import type { AppGitSettings } from "./apps";

const execFileP = promisify(execFile);

const SHORT_TIMEOUT_MS = 5_000;
const PUSH_TIMEOUT_MS = 60_000;
const AUTO_BRANCH_PREFIX = "claude/";

/**
 * Per-cwd serialization for sequential git commands. Two children of
 * the same task on the same app finish nearly simultaneously? Both
 * reach `autoCommitAndPush` at almost the same time — `git add -A` +
 * `git commit` are NOT atomic against each other, and `git push`
 * shells out separately. Without serialization, you get
 * "another git process seems to be running" or, worse, a commit that
 * mixes file changes from two unrelated children.
 *
 * The chain is HMR-safe via globalThis (same trick as
 * `__bridgeMetaWriteQueues`) so a Next.js hot reload doesn't drop
 * the in-flight serialization head.
 *
 * On top of the in-process queue we also acquire a cross-process
 * advisory lock (`acquireFileLock`) so the bridge dev server and a
 * developer running `git commit` by hand in the same repo don't race
 * each other. The in-process queue makes contention within the
 * bridge cheap; the file lock catches contention that crosses the
 * process boundary.
 */
const GW = globalThis as unknown as {
  __bridgeGitQueues?: Map<string, Promise<unknown>>;
};
const gitQueues: Map<string, Promise<unknown>> =
  GW.__bridgeGitQueues ?? new Map<string, Promise<unknown>>();
GW.__bridgeGitQueues = gitQueues;

const LOCK_DIRNAME = ".bridge-git-lock";
const LOCK_STALE_MS = 5 * 60 * 1000;
const LOCK_RETRY_MS = 100;
const LOCK_MAX_WAIT_MS = 30 * 1000;

interface FileLockHandle {
  release: () => void;
}

/**
 * Pick the directory the lock will live in. Prefer `<cwd>/.git/` so
 * the lock travels with the working tree, doesn't pollute the
 * project root listing, and is automatically gitignored by virtue
 * of being inside `.git`. Fall back to `<cwd>` itself when `.git`
 * is absent (a worktree's `.git` is a file, not a dir; in that case
 * we use the cwd directly).
 */
function lockDirFor(cwd: string): string {
  const dotGit = join(cwd, ".git");
  let useDotGit = false;
  try {
    useDotGit = statSync(dotGit).isDirectory();
  } catch { /* missing or .git is a file (worktree pointer) */ }
  return join(useDotGit ? dotGit : cwd, LOCK_DIRNAME);
}

/**
 * Acquire an OS-level advisory lock by creating a sentinel directory
 * — `mkdir` is atomic across processes on every supported platform.
 * Returns a handle on success, or `null` if the lock couldn't be
 * acquired within `LOCK_MAX_WAIT_MS`. Writes a small `owner` file
 * inside the directory so a future stale-lock pass can decide to
 * forcibly evict an abandoned lock.
 */
async function acquireFileLock(cwd: string): Promise<FileLockHandle | null> {
  const lockDir = lockDirFor(cwd);
  const start = Date.now();
  while (Date.now() - start < LOCK_MAX_WAIT_MS) {
    try {
      mkdirSync(lockDir);
      try {
        writeFileSync(
          join(lockDir, "owner"),
          JSON.stringify({ pid: process.pid, t: Date.now() }),
        );
      } catch { /* diagnostic-only — lock already held by us */ }
      return {
        release() {
          try { rmSync(lockDir, { recursive: true, force: true }); }
          catch { /* lock dir gone? fine */ }
        },
      };
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") {
        // ENOENT means the parent (.git/ or cwd) doesn't exist —
        // surface as un-acquirable rather than throwing into the
        // queue, since the caller can't do anything about it.
        return null;
      }
      // Stale-lock detection: if the existing dir is older than
      // LOCK_STALE_MS, the previous holder crashed before releasing.
      // Try the owner file's timestamp first, fall back to dir mtime.
      try {
        const ownerPath = join(lockDir, "owner");
        let ownerAge = Number.POSITIVE_INFINITY;
        if (existsSync(ownerPath)) {
          try {
            const parsed = JSON.parse(readFileSync(ownerPath, "utf8")) as { t?: number };
            if (typeof parsed.t === "number") ownerAge = Date.now() - parsed.t;
          } catch { /* fall through to dir mtime */ }
        }
        if (!Number.isFinite(ownerAge)) {
          try { ownerAge = Date.now() - statSync(lockDir).mtimeMs; }
          catch { /* lock dir vanished between EEXIST and stat */ }
        }
        if (Number.isFinite(ownerAge) && ownerAge > LOCK_STALE_MS) {
          try { rmSync(lockDir, { recursive: true, force: true }); }
          catch { /* race with another waiter — fine, retry */ }
          continue;
        }
      } catch { /* keep waiting */ }
      await new Promise<void>((r) => setTimeout(r, LOCK_RETRY_MS));
    }
  }
  return null;
}

export async function withGitLock<T>(
  cwd: string,
  fn: () => T | Promise<T>,
): Promise<T> {
  const runWithCrossProcLock = async (): Promise<T> => {
    const lock = await acquireFileLock(cwd);
    if (!lock) {
      throw new Error(
        `gitOps: failed to acquire cross-process lock at ${lockDirFor(cwd)} within ${LOCK_MAX_WAIT_MS}ms`,
      );
    }
    try {
      return await fn();
    } finally {
      lock.release();
    }
  };
  const prev = gitQueues.get(cwd) ?? Promise.resolve();
  const next: Promise<T> = prev.then(runWithCrossProcLock, runWithCrossProcLock);
  const tail = next.catch(() => {});
  gitQueues.set(cwd, tail);
  try {
    return await next;
  } finally {
    if (gitQueues.get(cwd) === tail) gitQueues.delete(cwd);
  }
}

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

/** Public view of `currentBranch` for callers (coordinator merge step). */
export async function readCurrentBranch(cwd: string): Promise<string | null> {
  if (!isGitRepo(cwd)) return null;
  return currentBranch(cwd);
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
  return withGitLock(cwd, () => prepareBranchLocked(cwd, settings, taskId));
}

async function prepareBranchLocked(
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

  // Refuse to clobber uncommitted edits in the live tree. Without this
  // guard, `git checkout <branch>` either errors (best case) or carries
  // dirty files across to the new branch — the operator's WIP gets
  // silently mixed into a child agent's run. The check is cheap; the
  // safer outcome is to fail the spawn and let the operator commit /
  // stash / use worktree mode.
  const dirty = await runGit(cwd, ["status", "--porcelain"]);
  if (dirty.ok && dirty.stdout.trim().length > 0) {
    return {
      ok: false,
      message:
        "branch prep aborted: working tree has uncommitted changes — commit / stash, or enable worktreeMode",
      error: dirty.stdout.trim().slice(0, 800),
    };
  }

  if (settings.branchMode === "fixed") {
    const branch = settings.fixedBranch.trim();
    if (!branch) {
      return { ok: false, message: "fixedBranch is required for branchMode=fixed" };
    }
    return checkoutOrCreate(cwd, branch);
  }

  if (settings.branchMode === "auto-create") {
    // Each child gets its OWN branch, even on retried tasks. Re-using
    // `claude/<taskId>` for retry runs silently piles new commits on
    // top of the prior run — the operator has no signal that happened
    // and the diff endpoint then mixes both runs' edits. Suffix with
    // a short unique tag based on wall-clock + random so two children
    // of the same retry never collide either.
    const branch =
      AUTO_BRANCH_PREFIX +
      sanitizeBranchSegment(taskId) +
      "-" +
      uniqueBranchSuffix();
    return checkoutOrCreate(cwd, branch);
  }

  return { ok: false, message: `unsupported branchMode: ${settings.branchMode}` };
}

/**
 * 8-char suffix combining a base36-encoded timestamp and crypto-random
 * tail. Long enough that two spawns within the same ms don't collide
 * (Math.random gives ~52 bits of entropy), short enough to keep the
 * branch name human-scannable.
 */
function uniqueBranchSuffix(): string {
  const ts = Date.now().toString(36).slice(-4);
  const r = Math.random().toString(36).slice(2, 6);
  return `${ts}${r}`;
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
  return withGitLock(cwd, () => autoCommitAndPushLocked(cwd, settings, message));
}

async function autoCommitAndPushLocked(
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

/**
 * Branches the bridge will NEVER auto-push to, even when `autoPush=true`
 * and an upstream tracking ref already exists. With `branchMode=current`
 * the operator's HEAD is whatever they left it on, and pushing
 * AI-generated commits straight to a project's main / release branch
 * is rarely what they actually want.
 *
 * Override per-app by setting `branchMode` to `fixed` or `auto-create`
 * so the bridge places work on a non-protected branch first.
 */
const PROTECTED_BRANCHES = new Set([
  "main",
  "master",
  "trunk",
  "develop",
  "production",
  "prod",
  "release",
]);

async function tryPush(cwd: string): Promise<GitOpResult> {
  const branch = await currentBranch(cwd);
  if (branch && PROTECTED_BRANCHES.has(branch.toLowerCase())) {
    return {
      ok: false,
      message: `auto-push skipped: refusing to push to protected branch "${branch}"`,
      error: `change branchMode to "fixed" or "auto-create" to land work on a non-protected branch`,
    };
  }
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

/**
 * Merge `sourceBranch` into `targetBranch` (no-fast-forward) and leave
 * HEAD on target. Used by the post-success integration step when the
 * operator configured `mergeTargetBranch`. Conflict-safe: any failure
 * runs `git merge --abort`, returns HEAD to `sourceBranch`, and reports
 * `ok: false` so the caller surfaces a warning to the operator.
 *
 * Pre-conditions:
 *  - cwd is a git repo
 *  - working tree is clean (caller already auto-committed)
 *  - sourceBranch is the currently-checked-out branch (we don't
 *    re-verify, but the caller in coordinator.ts ensures this)
 *
 * If `targetBranch === sourceBranch` we no-op (success). If the target
 * branch doesn't exist locally we create it from the source's tip —
 * matches `prepareBranch`'s behavior for `fixed` mode and lets a fresh
 * repo bootstrap an integration branch on the first run.
 *
 * `push` runs `git push` on the target after a successful merge so
 * `autoPush=true` reaches the merged result.
 */
export async function mergeIntoTargetBranch(args: {
  cwd: string;
  sourceBranch: string;
  targetBranch: string;
  message: string;
  push: boolean;
}): Promise<GitOpResult> {
  return withGitLock(args.cwd, () => mergeIntoTargetBranchLocked(args));
}

async function mergeIntoTargetBranchLocked(args: {
  cwd: string;
  sourceBranch: string;
  targetBranch: string;
  message: string;
  push: boolean;
}): Promise<GitOpResult> {
  const { cwd, sourceBranch, targetBranch, message, push } = args;
  if (!isGitRepo(cwd)) {
    return { ok: false, message: `not a git repo: ${cwd}`, error: "missing .git" };
  }
  const target = targetBranch.trim();
  const source = sourceBranch.trim();
  if (!target) {
    return { ok: true, message: "no merge target configured" };
  }
  if (!source) {
    return { ok: false, message: "merge: source branch is empty" };
  }
  if (source === target) {
    return { ok: true, message: `merge skipped: source == target (${target})` };
  }

  // Refuse to merge if the working tree has uncommitted changes — that
  // means autoCommit didn't run / didn't finish, and a checkout-then-
  // merge would either fail or carry dirty edits across branches.
  const dirty = await runGit(cwd, ["status", "--porcelain"]);
  if (dirty.ok && dirty.stdout.trim().length > 0) {
    return {
      ok: false,
      message: "merge skipped: working tree has uncommitted changes",
      error: dirty.stdout.trim(),
    };
  }

  // Checkout (or create) target. We deliberately skip remote tracking
  // here — operators who want their target branch to track origin can
  // configure that themselves; the bridge shouldn't guess remote intent.
  const targetExists = await branchExists(cwd, target);
  const checkout = await runGit(
    cwd,
    targetExists ? ["checkout", target] : ["checkout", "-b", target],
  );
  if (!checkout.ok) {
    return {
      ok: false,
      message: `git checkout ${target} failed`,
      error: checkout.stderr || `exit ${checkout.code}`,
    };
  }

  // If we just created the target from source's tip, there's literally
  // nothing to merge — they point at the same commit. Push if asked.
  if (!targetExists) {
    if (push) {
      const p = await tryPush(cwd);
      return {
        ok: p.ok,
        message: `created ${target} from ${source}; ${p.message}`,
        error: p.error,
      };
    }
    return { ok: true, message: `created ${target} from ${source}` };
  }

  const merge = await runGit(cwd, [
    "merge",
    "--no-ff",
    source,
    "-m",
    message,
  ]);
  if (!merge.ok) {
    // Conflict (or any other merge failure): abort cleanly, return to
    // source so the operator finds their work where they left it.
    await runGit(cwd, ["merge", "--abort"]);
    await runGit(cwd, ["checkout", source]);
    return {
      ok: false,
      message: `git merge ${source} → ${target} failed (aborted, back on ${source})`,
      error: merge.stderr || `exit ${merge.code}`,
    };
  }

  if (!push) {
    return { ok: true, message: `merged ${source} → ${target}` };
  }
  const p = await tryPush(cwd);
  if (!p.ok) {
    return {
      ok: false,
      message: `merged ${source} → ${target}, but push failed: ${p.message}`,
      error: p.error,
    };
  }
  return { ok: true, message: `merged ${source} → ${target} + pushed` };
}
