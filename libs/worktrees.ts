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
import { sanitizeBranchSegment, withGitLock } from "./gitOps";
import { readMeta } from "./meta";
import { SESSIONS_DIR } from "./paths";

const execFileP = promisify(execFile);

const SHORT_TIMEOUT_MS = 10_000;
const PRUNE_TIMEOUT_MS = 30_000;
const WORKTREE_ADD_TIMEOUT_MS = 60_000;
const WORKTREES_DIRNAME = ".worktrees";
const WORKTREE_BRANCH_PREFIX = "claude/wt/";
const DEFAULT_STALE_HOURS = 24;

export interface WorktreeHandle {
  path: string;
  branch: string;
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

export function worktreePathFor(appPath: string, sessionId: string): string {
  return join(appPath, WORKTREES_DIRNAME, sessionId);
}

export function isStrictlyUnderAppRoot(appPath: string, candidate: string): boolean {
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

function mintSpawnBranch(taskId: string, sessionId: string): string {
  const shortSid = sessionId.replace(/-/g, "").slice(0, 8);
  return `${WORKTREE_BRANCH_PREFIX}${sanitizeBranchSegment(taskId)}-${shortSid}`;
}

async function resolveBaseBranch(
  appPath: string,
  settings: AppGitSettings,
  taskId: string,
): Promise<string | null> {
  const liveHead = await currentBranch(appPath);
  if (settings.branchMode === "fixed" && settings.fixedBranch.trim()) {
    const branch = settings.fixedBranch.trim();
    if (await branchExists(appPath, branch)) return branch;
    return liveHead;
  }
  if (settings.branchMode === "auto-create") {
    const branch = `claude/${sanitizeBranchSegment(taskId)}`;
    if (await branchExists(appPath, branch)) return branch;
    if (liveHead) {
      const r = await runGit(appPath, ["branch", branch, liveHead]);
      if (r.ok) return branch;
    }
    return liveHead;
  }
  return liveHead;
}

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
  if (!isStrictlyUnderAppRoot(appPath, wtPath)) return null;

  try {
    mkdirSync(join(appPath, WORKTREES_DIRNAME), { recursive: true });
  } catch {
    return null;
  }
  if (existsSync(wtPath)) {
    return null;
  }

  const baseBranch = await resolveBaseBranch(appPath, settings, taskId);
  const spawnBranch = mintSpawnBranch(taskId, sessionId);

  const addArgs: string[] = [
    "worktree",
    "add",
    "-b",
    spawnBranch,
    wtPath,
  ];
  if (baseBranch) addArgs.push(baseBranch);
  const r = await runGit(appPath, addArgs, WORKTREE_ADD_TIMEOUT_MS);
  if (!r.ok) {
    await runGit(appPath, ["worktree", "prune"], PRUNE_TIMEOUT_MS);
    return null;
  }

  return { path: wtPath, branch: spawnBranch, baseBranch };
}

export async function removeWorktree(args: {
  appPath: string;
  worktreePath: string;
}): Promise<WorktreeOpResult> {
  const { appPath, worktreePath } = args;
  if (!isStrictlyUnderAppRoot(appPath, worktreePath)) {
    return {
      ok: false,
      message: "refusing to remove path outside app root",
      error: worktreePath,
    };
  }
  if (!existsSync(worktreePath)) {
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

export async function mergeAndRemoveWorktree(args: {
  appPath: string;
  handle: WorktreeHandle;
}): Promise<WorktreeOpResult> {
  return withGitLock(args.appPath, () => mergeAndRemoveWorktreeLocked(args));
}

async function mergeAndRemoveWorktreeLocked(args: {
  appPath: string;
  handle: WorktreeHandle;
}): Promise<WorktreeOpResult> {
  const { appPath, handle } = args;

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
    return removeWorktree({ appPath, worktreePath: handle.path });
  }

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

  const merge = await runGit(appPath, [
    "merge",
    "--no-ff",
    "--no-edit",
    handle.branch,
  ]);
  if (!merge.ok) {
    await runGit(appPath, ["merge", "--abort"]);
    return {
      ok: false,
      message: `merge of ${handle.branch} into ${handle.baseBranch} failed (aborted; worktree kept at ${handle.path})`,
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

function collectActiveSessionIds(): Set<string> {
  const out = new Set<string>();
  if (!existsSync(SESSIONS_DIR)) return out;
  let taskDirs: string[] = [];
  try {
    taskDirs = readdirSync(SESSIONS_DIR);
  } catch {
    return out;
  }
  for (const taskId of taskDirs) {
    const dir = join(SESSIONS_DIR, taskId);
    let meta;
    try {
      meta = readMeta(dir);
    } catch {
      continue;
    }
    if (!meta) continue;
    for (const r of meta.runs) {
      const inFlight = r.status === "queued" || r.status === "running";
      const heldForReview = !!r.confidence?.heldAt && !r.confidence.reviewedBy;
      if (inFlight || heldForReview) {
        out.add(r.sessionId);
      }
    }
  }
  return out;
}

function staleHours(): number {
  const raw = process.env.BRIDGE_WORKTREE_STALE_HOURS;
  const n = raw ? Number(raw) : DEFAULT_STALE_HOURS;
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_STALE_HOURS;
}

export async function pruneStaleWorktrees(args: {
  appPath: string;
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
  const activeSessions = collectActiveSessionIds();
  let removed = 0;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const wt = join(root, entry.name);
    if (!isStrictlyUnderAppRoot(appPath, wt)) continue;
    if (activeSessions.has(entry.name)) continue;
    let recent = false;
    try {
      recent = statSync(wt).mtimeMs > cutoffMs
        || hasRecentEdit(wt, cutoffMs);
    } catch {
      continue;
    }
    if (recent) continue;
    const r = await removeWorktree({ appPath, worktreePath: wt });
    if (r.ok) removed += 1;
  }
  return removed;
}

const STALE_SCAN_SKIP_NAMES: ReadonlySet<string> = new Set([
  ".git", ".hg", ".svn",
  "node_modules", ".pnpm", ".yarn",
  ".next", ".turbo", ".cache", ".parcel-cache",
  "dist", "build", "out", "target",
  "coverage", ".nyc_output",
  "__pycache__", ".venv", "venv",
  ".bridge-state",
]);

const STALE_SCAN_MAX_DEPTH = 5;

function hasRecentEdit(dir: string, cutoffMs: number): boolean {
  const stack: Array<{ path: string; depth: number }> = [{ path: dir, depth: 0 }];
  while (stack.length > 0) {
    const { path, depth } = stack.pop()!;
    let kids: import("node:fs").Dirent[];
    try {
      kids = readdirSync(path, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const k of kids) {
      if (STALE_SCAN_SKIP_NAMES.has(k.name)) continue;
      const child = join(path, k.name);
      try {
        if (statSync(child).mtimeMs > cutoffMs) return true;
      } catch {
        continue;
      }
      if (k.isDirectory() && depth + 1 < STALE_SCAN_MAX_DEPTH) {
        stack.push({ path: child, depth: depth + 1 });
      }
    }
  }
  return false;
}

export function _normalize(p: string): string {
  return normalize(p);
}

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
