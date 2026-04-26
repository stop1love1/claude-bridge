/**
 * P4/F1 — git worktree sandbox per spawned run.
 *
 * When `app.git.worktreeMode === "enabled"`, the bridge creates a
 * private worktree at `<appRoot>/.worktrees/<sessionId>` BEFORE the
 * child agent spawns. The child runs in that cwd; its edits stay
 * isolated from the live tree until the post-exit gates pass.
 *
 * Lifecycle:
 *
 *   1. `createWorktreeForRun` — runs before spawn. Creates the worktree
 *      on the configured branch (auto-create / fixed / current). Returns
 *      the path the agent should run in plus the branch name.
 *
 *   2. Child writes code + report inside the worktree.
 *
 *   3. After all post-exit gates pass and (optionally) auto-commit
 *      committed in the worktree, `mergeAndRemoveWorktree` rebases the
 *      worktree branch onto the parent branch and removes the worktree.
 *
 *   4. On gate failure or unexpected crash, the worktree is left in
 *      place for inspection. `pruneStaleWorktrees` reaps anything older
 *      than the configured TTL (default 24h) on later API hits.
 *
 * Windows note: `git worktree remove` can fail if a process inside the
 * worktree is still holding a file handle (Claude's `.jsonl` writer is
 * the usual culprit). We pass `--force` and fall back to manual `rm -rf`
 * + `git worktree prune` to mop up.
 */
import { execFile } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { isAbsolute, join, normalize, resolve, sep } from "node:path";
import { promisify } from "node:util";
import type { AppGitSettings } from "./apps";
import { sanitizeBranchSegment } from "./gitOps";

const execFileP = promisify(execFile);

const SHORT_TIMEOUT_MS = 10_000;
const PRUNE_TIMEOUT_MS = 30_000;
const WORKTREES_DIRNAME = ".worktrees";
const WORKTREE_BRANCH_PREFIX = "claude/wt/";
/** Default TTL for stale worktree pruning. Configurable via env. */
const DEFAULT_STALE_HOURS = 24;

export interface WorktreeHandle {
  /** Absolute path of the worktree directory. */
  path: string;
  /** Branch the worktree was created on (or checked out into). */
  branch: string;
  /**
   * Branch the worktree was forked from — used as the merge target on
   * cleanup. Null means the bridge couldn't determine HEAD (detached
   * head, fresh repo) so cleanup falls back to skipping the merge.
   */
  baseBranch: string | null;
}

export interface WorktreeOpResult {
  ok: boolean;
  message: string;
  error?: string;
}

interface ExecResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  code: number;
}

async function runGit(
  cwd: string,
  args: string[],
  timeoutMs = SHORT_TIMEOUT_MS,
): Promise<ExecResult> {
  try {
    const { stdout } = await execFileP("git", args, {
      cwd,
      timeout: timeoutMs,
      windowsHide: true,
      maxBuffer: 1 << 20,
    });
    return { ok: true, stdout: stdout.toString(), stderr: "", code: 0 };
  } catch (err) {
    const e = err as NodeJS.ErrnoException & {
      stderr?: Buffer | string;
      stdout?: Buffer | string;
      code?: number;
    };
    const stderr =
      typeof e.stderr === "string" ? e.stderr : e.stderr?.toString() ?? "";
    const stdout =
      typeof e.stdout === "string" ? e.stdout : e.stdout?.toString() ?? "";
    return {
      ok: false,
      stdout,
      stderr: stderr.trim() || (e.message ?? "git failed"),
      code: typeof e.code === "number" ? e.code : 1,
    };
  }
}

/** Compute the worktree directory for a given session under the app. */
export function worktreePathFor(appPath: string, sessionId: string): string {
  return join(appPath, WORKTREES_DIRNAME, sessionId);
}

/**
 * Defense-in-depth: ensure a worktree path resolves under the app
 * root. The session id is UUID-validated upstream so this is layered
 * paranoia, not the primary check.
 */
function isUnderAppRoot(appPath: string, candidate: string): boolean {
  const a = resolve(appPath);
  const c = resolve(candidate);
  if (a === c) return false;
  return c.startsWith(a + sep) || c.startsWith(a + "/");
}

async function currentBranch(cwd: string): Promise<string | null> {
  const r = await runGit(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (!r.ok) return null;
  const name = r.stdout.trim();
  return name && name !== "HEAD" ? name : null;
}

async function branchExists(cwd: string, branch: string): Promise<boolean> {
  const r = await runGit(cwd, [
    "rev-parse",
    "--verify",
    "--quiet",
    `refs/heads/${branch}`,
  ]);
  return r.ok;
}

/**
 * Mint the unique per-spawn branch the worktree will execute on.
 * Always unique — using `branchMode`'s natural branch (e.g. `main`,
 * `claude/<task>`) would clash whenever that branch is already
 * checked out in the live tree (`git worktree add` refuses), or two
 * concurrent spawns chose the same name. The actual merge target is
 * computed separately by `resolveBaseBranch`.
 */
function mintSpawnBranch(taskId: string, sessionId: string): string {
  const shortSid = sessionId.replace(/-/g, "").slice(0, 8);
  return `${WORKTREE_BRANCH_PREFIX}${sanitizeBranchSegment(taskId)}-${shortSid}`;
}

/**
 * Resolve the branch the worktree should fork from. The bridge merges
 * back into this branch on cleanup, so it's the eventual landing
 * place for the agent's commits:
 *
 *   - `fixed`       → `fixedBranch` if it exists locally, else current HEAD.
 *   - `auto-create` → `claude/<taskId>` (auto-created from current HEAD if missing).
 *   - `current`     → current HEAD branch.
 *
 * Returns `null` when the live tree is on a detached HEAD and we
 * couldn't materialize a base — caller falls through, the worktree
 * forks from HEAD without an explicit base, and merge is skipped on
 * cleanup.
 */
async function resolveBaseBranch(
  appPath: string,
  settings: AppGitSettings,
  taskId: string,
): Promise<string | null> {
  const liveHead = await currentBranch(appPath);
  if (settings.branchMode === "fixed" && settings.fixedBranch.trim()) {
    const branch = settings.fixedBranch.trim();
    if (await branchExists(appPath, branch)) return branch;
    // Fixed branch doesn't exist locally — fall back to live HEAD so
    // the worktree still gets created. Operator's job to populate the
    // ref before relying on it.
    return liveHead;
  }
  if (settings.branchMode === "auto-create") {
    const branch = `claude/${sanitizeBranchSegment(taskId)}`;
    if (await branchExists(appPath, branch)) return branch;
    // Materialize the auto-create branch from current HEAD so the
    // worktree has a valid base to fork from. We use `git branch`
    // (no checkout) so the live tree's HEAD stays put.
    if (liveHead) {
      const r = await runGit(appPath, ["branch", branch, liveHead]);
      if (r.ok) return branch;
    }
    return liveHead;
  }
  return liveHead;
}

/**
 * Create a private worktree for a spawned run. Returns null on any
 * failure (caller falls back to spawning in the live tree, with a
 * warning logged). On Windows the worktree dir is created with
 * `mkdir -p` semantics first so `git worktree add` doesn't trip on a
 * missing parent.
 */
export async function createWorktreeForRun(args: {
  appPath: string;
  settings: AppGitSettings;
  taskId: string;
  sessionId: string;
}): Promise<WorktreeHandle | null> {
  const { appPath, settings, taskId, sessionId } = args;
  if (!isAbsolute(appPath)) return null;
  if (!existsSync(join(appPath, ".git"))) return null;

  const wtPath = worktreePathFor(appPath, sessionId);
  if (!isUnderAppRoot(appPath, wtPath)) return null;

  // Make sure the parent .worktrees/ dir exists. `git worktree add`
  // creates the leaf, but a missing intermediate dir is a Windows
  // pain.
  try {
    mkdirSync(join(appPath, WORKTREES_DIRNAME), { recursive: true });
  } catch {
    return null;
  }
  if (existsSync(wtPath)) {
    // Stale leftover from a prior crashed spawn — refuse to clobber.
    return null;
  }

  const baseBranch = await resolveBaseBranch(appPath, settings, taskId);
  const spawnBranch = mintSpawnBranch(taskId, sessionId);

  // `git worktree add -b <newBranch> <path> [<startPoint>]`
  // The spawn branch is always fresh (per-session unique), so we can
  // unconditionally use the `-b` form. Passing `<startPoint>` makes
  // the new branch fork from the configured base; omitting it forks
  // from current HEAD (which is the same in `current` mode and a safe
  // fallback when baseBranch resolution failed).
  const addArgs: string[] = [
    "worktree",
    "add",
    "-b",
    spawnBranch,
    wtPath,
  ];
  if (baseBranch) addArgs.push(baseBranch);
  const r = await runGit(appPath, addArgs);
  if (!r.ok) {
    await runGit(appPath, ["worktree", "prune"], PRUNE_TIMEOUT_MS);
    return null;
  }

  return { path: wtPath, branch: spawnBranch, baseBranch };
}

/**
 * Remove a worktree directory + the matching git registration. Tries
 * `git worktree remove --force` first (clean path); on Windows a
 * locked file handle can make that fail, so we fall back to manual
 * rmdir + `git worktree prune`.
 *
 * Returns ok=true even when the directory was already gone — callers
 * are idempotent about this.
 */
export async function removeWorktree(args: {
  appPath: string;
  worktreePath: string;
}): Promise<WorktreeOpResult> {
  const { appPath, worktreePath } = args;
  if (!isUnderAppRoot(appPath, worktreePath)) {
    return {
      ok: false,
      message: "refusing to remove path outside app root",
      error: worktreePath,
    };
  }
  if (!existsSync(worktreePath)) {
    // Already gone — still prune the registration in case git's index
    // remembers it.
    await runGit(appPath, ["worktree", "prune"], PRUNE_TIMEOUT_MS);
    return { ok: true, message: "worktree already removed" };
  }
  const remove = await runGit(
    appPath,
    ["worktree", "remove", "--force", worktreePath],
    PRUNE_TIMEOUT_MS,
  );
  if (remove.ok) {
    return { ok: true, message: `removed worktree ${worktreePath}` };
  }
  // Windows fallback: manual rmdir then prune the registration.
  try {
    rmSync(worktreePath, { recursive: true, force: true, maxRetries: 3 });
  } catch (e) {
    return {
      ok: false,
      message: `worktree remove failed and rm fallback errored: ${(e as Error).message}`,
      error: remove.stderr,
    };
  }
  await runGit(appPath, ["worktree", "prune"], PRUNE_TIMEOUT_MS);
  return { ok: true, message: `removed worktree (rm fallback) ${worktreePath}` };
}

/**
 * After a successful run + auto-commit (which committed to the
 * worktree's branch), merge that branch back into the base branch and
 * remove the worktree. The merge happens in the live app tree, not in
 * the worktree (you can't operate on a branch that's checked out in
 * another worktree).
 *
 * Fail-soft: any merge failure leaves the worktree in place (caller
 * surfaces the error to the operator) but never throws.
 */
export async function mergeAndRemoveWorktree(args: {
  appPath: string;
  handle: WorktreeHandle;
}): Promise<WorktreeOpResult> {
  const { appPath, handle } = args;

  // No base branch means the worktree was created on a detached HEAD
  // or a fresh repo. There's nothing meaningful to merge into — just
  // remove the worktree and surface a note.
  if (!handle.baseBranch) {
    const removed = await removeWorktree({
      appPath,
      worktreePath: handle.path,
    });
    return {
      ok: removed.ok,
      message: `no base branch to merge into; ${removed.message}`,
      error: removed.error,
    };
  }
  if (handle.baseBranch === handle.branch) {
    // Worktree shared the base branch (branchMode=fixed pointing at the
    // current branch). Auto-commit already committed onto that branch
    // from inside the worktree, so the live tree is already up to date
    // — just remove the worktree.
    return removeWorktree({ appPath, worktreePath: handle.path });
  }

  // Make sure the live tree is on the base branch before merging.
  const liveCur = await currentBranch(appPath);
  if (liveCur !== handle.baseBranch) {
    const co = await runGit(appPath, ["checkout", handle.baseBranch]);
    if (!co.ok) {
      return {
        ok: false,
        message: `failed to checkout base branch ${handle.baseBranch}`,
        error: co.stderr,
      };
    }
  }

  // Use --no-ff so the merge commit is preserved even on fast-forward
  // candidates; preserves the audit trail of "this work came from a
  // bridge worktree".
  const merge = await runGit(appPath, [
    "merge",
    "--no-ff",
    "--no-edit",
    handle.branch,
  ]);
  if (!merge.ok) {
    return {
      ok: false,
      message: `merge of ${handle.branch} into ${handle.baseBranch} failed`,
      error: merge.stderr,
    };
  }

  const removed = await removeWorktree({
    appPath,
    worktreePath: handle.path,
  });
  return {
    ok: removed.ok,
    message: `merged ${handle.branch} into ${handle.baseBranch}; ${removed.message}`,
    error: removed.error,
  };
}

function staleHours(): number {
  const raw = process.env.BRIDGE_WORKTREE_STALE_HOURS;
  const n = raw ? Number(raw) : DEFAULT_STALE_HOURS;
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_STALE_HOURS;
}

/**
 * Reap worktree directories under `<appPath>/.worktrees/` whose mtime
 * is older than the configured TTL. Cheap to call from the same hot
 * path that triggers `staleRunReaper` (no extra background process).
 *
 * Returns the count of worktrees actually removed.
 */
export async function pruneStaleWorktrees(args: {
  appPath: string;
  /** Override TTL for tests. Falls back to `BRIDGE_WORKTREE_STALE_HOURS` env. */
  staleAfterMs?: number;
}): Promise<number> {
  const { appPath } = args;
  const root = join(appPath, WORKTREES_DIRNAME);
  if (!existsSync(root)) return 0;

  const cutoffMs =
    Date.now() - (args.staleAfterMs ?? staleHours() * 60 * 60 * 1000);
  let entries: import("node:fs").Dirent[];
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return 0;
  }
  let removed = 0;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const wt = join(root, entry.name);
    if (!isUnderAppRoot(appPath, wt)) continue;
    // The dir's own mtime only ticks on entry add/remove — an agent
    // modifying existing files would otherwise look idle. Walk the
    // immediate top-level children and take the max mtime as a
    // cheap proxy for "last write activity inside the worktree".
    let mtimeMs: number;
    try {
      mtimeMs = statSync(wt).mtimeMs;
      let kids: import("node:fs").Dirent[] = [];
      try {
        kids = readdirSync(wt, { withFileTypes: true });
      } catch { /* unreadable — fall through to root mtime only */ }
      for (const k of kids) {
        if (k.name === ".git") continue;
        try {
          const km = statSync(join(wt, k.name)).mtimeMs;
          if (km > mtimeMs) mtimeMs = km;
        } catch { /* ignore individual entry errors */ }
      }
    } catch {
      continue;
    }
    if (mtimeMs > cutoffMs) continue;
    const r = await removeWorktree({ appPath, worktreePath: wt });
    if (r.ok) removed += 1;
  }
  return removed;
}

/** Test-only helper: expose the canonical normalized path. */
export function _normalize(p: string): string {
  return normalize(p);
}

/**
 * (P4) Pull the worktree-related fields off a parent run so a retry
 * spawn can inherit them. Each retry runs in the SAME worktree as the
 * run it's retrying — otherwise the retry would spawn in the live tree
 * and never see the parent's WIP edits, defeating the whole point of
 * the sandbox. Returns an empty object when the parent didn't run in a
 * worktree, so callers can spread it unconditionally.
 */
export function inheritWorktreeFields(parent: {
  worktreePath?: string | null;
  worktreeBranch?: string | null;
  worktreeBaseBranch?: string | null;
}): {
  worktreePath: string | null;
  worktreeBranch: string | null;
  worktreeBaseBranch: string | null;
} {
  return {
    worktreePath: parent.worktreePath ?? null,
    worktreeBranch: parent.worktreeBranch ?? null,
    worktreeBaseBranch: parent.worktreeBaseBranch ?? null,
  };
}
