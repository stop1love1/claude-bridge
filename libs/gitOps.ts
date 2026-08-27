import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import type { AppGitSettings } from "./apps";

const execFileP = promisify(execFile);

const SHORT_TIMEOUT_MS = 5_000;
const PUSH_TIMEOUT_MS = 60_000;
const AUTO_BRANCH_PREFIX = "claude/";

const GW = globalThis as unknown as {
  __bridgeGitQueues?: Map<string, Promise<unknown>>;
  __bridgeRemotePushQueues?: Map<string, Promise<unknown>>;
};
const gitQueues: Map<string, Promise<unknown>> =
  GW.__bridgeGitQueues ?? new Map<string, Promise<unknown>>();
GW.__bridgeGitQueues = gitQueues;

const remotePushQueues: Map<string, Promise<unknown>> =
  GW.__bridgeRemotePushQueues ?? new Map<string, Promise<unknown>>();
GW.__bridgeRemotePushQueues = remotePushQueues;

const LOCK_DIRNAME = ".bridge-git-lock";
const LOCK_STALE_MS = 5 * 60 * 1000;
const LOCK_RETRY_MS = 100;
const LOCK_MAX_WAIT_MS = 30 * 1000;

interface FileLockHandle {
  release: () => void;
}

function lockDirFor(cwd: string): string {
  const dotGit = join(cwd, ".git");
  let useDotGit = false;
  try {
    useDotGit = statSync(dotGit).isDirectory();
  } catch { }
  return join(useDotGit ? dotGit : cwd, LOCK_DIRNAME);
}

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
      } catch { }
      return {
        release() {
          try { rmSync(lockDir, { recursive: true, force: true }); }
          catch { }
        },
      };
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") {
        return null;
      }
      try {
        const ownerPath = join(lockDir, "owner");
        let ownerAge = Number.POSITIVE_INFINITY;
        if (existsSync(ownerPath)) {
          try {
            const parsed = JSON.parse(readFileSync(ownerPath, "utf8")) as { t?: number };
            if (typeof parsed.t === "number") ownerAge = Date.now() - parsed.t;
          } catch { }
        }
        if (!Number.isFinite(ownerAge)) {
          try { ownerAge = Date.now() - statSync(lockDir).mtimeMs; }
          catch { }
        }
        if (Number.isFinite(ownerAge) && ownerAge > LOCK_STALE_MS) {
          try { rmSync(lockDir, { recursive: true, force: true }); }
          catch { }
          continue;
        }
      } catch { }
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
  message: string;
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

export async function readCurrentBranch(cwd: string): Promise<string | null> {
  if (!isGitRepo(cwd)) return null;
  return currentBranch(cwd);
}

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
    if (isGitRepo(cwd)) {
      const dirty = await runGit(cwd, ["status", "--porcelain"]);
      if (dirty.ok && dirty.stdout.trim().length > 0) {
        const filesPreview = dirty.stdout.trim().split(/\r?\n/).slice(0, 5).join(", ");
        return {
          ok: true,
          message:
            `branch policy: use current — WARNING tree has uncommitted changes (${filesPreview}${dirty.stdout.split(/\r?\n/).length > 5 ? ", …" : ""}); child agent will see / potentially commit them`,
        };
      }
    }
    return { ok: true, message: "branch policy: use current — no change" };
  }
  if (!isGitRepo(cwd)) {
    return { ok: false, message: `not a git repo: ${cwd}`, error: "missing .git" };
  }

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
    const branch =
      AUTO_BRANCH_PREFIX +
      sanitizeBranchSegment(taskId) +
      "-" +
      uniqueBranchSuffix();
    return checkoutOrCreate(cwd, branch);
  }

  return { ok: false, message: `unsupported branchMode: ${settings.branchMode}` };
}

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

  const add = await runGit(cwd, ["add", "-A"]);
  if (!add.ok) {
    return { ok: false, message: "git add -A failed", error: add.stderr };
  }

  const diff = await runGit(cwd, ["diff", "--cached", "--name-only"]);
  if (diff.ok && diff.stdout.trim().length === 0) {
    if (settings.autoPush) {
      return tryPush(cwd, settings.pushTimeoutMs);
    }
    return { ok: true, message: "no changes to commit" };
  }

  const commit = await runGit(cwd, [
    "commit",
    "-m",
    message,
    "-m",
    "Co-Authored-By: claude-bridge <noreply@anthropic.com>",
  ]);
  if (!commit.ok) {
    return { ok: false, message: "git commit failed", error: commit.stderr };
  }

  if (!settings.autoPush) {
    return { ok: true, message: "committed (auto-push disabled)" };
  }
  return tryPush(cwd, settings.pushTimeoutMs);
}

const PROTECTED_BRANCHES = new Set([
  "main",
  "master",
  "trunk",
  "develop",
  "production",
  "prod",
  "release",
]);

async function tryPush(
  cwd: string,
  pushTimeoutMs: number = PUSH_TIMEOUT_MS,
): Promise<GitOpResult> {
  const branch = await currentBranch(cwd);
  if (branch && PROTECTED_BRANCHES.has(branch.toLowerCase())) {
    return {
      ok: false,
      message: `auto-push skipped: refusing to push to protected branch "${branch}"`,
      error: `change branchMode to "fixed" or "auto-create" to land work on a non-protected branch`,
    };
  }
  const remoteKey = (await resolveRemoteKey(cwd)) ?? `cwd:${cwd}`;
  return withRemotePushLock(remoteKey, async () => {
    const r = await runGit(cwd, ["push"], { timeoutMs: pushTimeoutMs });
    if (!r.ok) {
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
  });
}

async function resolveRemoteKey(cwd: string): Promise<string | null> {
  const r = await runGit(cwd, ["remote", "get-url", "origin"]);
  if (!r.ok) return null;
  const url = r.stdout.trim();
  return url.length > 0 ? `remote:${url}` : null;
}

async function withRemotePushLock<T>(
  remoteKey: string,
  fn: () => Promise<T>,
): Promise<T> {
  const prev = remotePushQueues.get(remoteKey) ?? Promise.resolve();
  const next: Promise<T> = prev.then(fn, fn);
  const tail = next.catch(() => {});
  remotePushQueues.set(remoteKey, tail);
  try {
    return await next;
  } finally {
    if (remotePushQueues.get(remoteKey) === tail) {
      remotePushQueues.delete(remoteKey);
    }
  }
}

export async function mergeIntoTargetBranch(args: {
  cwd: string;
  sourceBranch: string;
  targetBranch: string;
  message: string;
  push: boolean;
  pushTimeoutMs?: number;
}): Promise<GitOpResult> {
  return withGitLock(args.cwd, () => mergeIntoTargetBranchLocked(args));
}

async function mergeIntoTargetBranchLocked(args: {
  cwd: string;
  sourceBranch: string;
  targetBranch: string;
  message: string;
  push: boolean;
  pushTimeoutMs?: number;
}): Promise<GitOpResult> {
  const { cwd, sourceBranch, targetBranch, message, push, pushTimeoutMs } = args;
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

  const dirty = await runGit(cwd, ["status", "--porcelain"]);
  if (dirty.ok && dirty.stdout.trim().length > 0) {
    return {
      ok: false,
      message: "merge skipped: working tree has uncommitted changes",
      error: dirty.stdout.trim(),
    };
  }

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

  if (!targetExists) {
    if (push) {
      const p = await tryPush(cwd, pushTimeoutMs);
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
  const p = await tryPush(cwd, pushTimeoutMs);
  if (!p.ok) {
    return {
      ok: false,
      message: `MERGE-NO-PUSH: merged ${source} → ${target} locally, but push failed: ${p.message}`,
      error: p.error,
    };
  }
  return { ok: true, message: `merged ${source} → ${target} + pushed` };
}
