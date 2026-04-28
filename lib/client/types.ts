/** Slash palette rows from `/api/repos/<name>/slash-commands`. */
export type SlashCommandsItemSource = "builtin" | "project" | "user";

export interface SlashCommandsItemDto {
  slug: string;
  description: string | null;
  source: SlashCommandsItemSource;
}

export type TaskStatus = "todo" | "doing" | "blocked" | "done";
export type TaskSection = "TODO" | "DOING" | "BLOCKED" | "DONE — not yet archived";

export interface Task {
  id: string;
  date: string;
  title: string;
  body: string;
  status: TaskStatus;
  section: TaskSection;
  checked: boolean;
  /** Target app name; `null` means "auto" (coordinator decides). */
  app?: string | null;
}

/**
 * `role` is free-form — the coordinator picks names based on the task.
 * Common built-ins the UI recognizes: "coordinator", "coder", "reviewer".
 * Anything else renders with a generic badge.
 */
export type RunStatus = "queued" | "running" | "done" | "failed" | "stale";

export interface Run {
  sessionId: string;
  role: string;
  repo: string;          // folder name of the repo this run targets
  status: RunStatus;
  startedAt: string | null;
  endedAt: string | null;
  /**
   * (Phase B+) The coordinator session UUID that spawned this run via
   * `POST /api/tasks/<id>/agents`. `null` / absent means the run was
   * spawned directly by the bridge (e.g. it IS the coordinator), or
   * by a pre-Phase-B path. Phase C uses this to draw the agent tree.
   */
  parentSessionId?: string | null;
}

export interface Meta {
  taskId: string;
  taskTitle: string;
  taskBody: string;
  taskStatus: TaskStatus;
  taskSection: TaskSection;
  taskChecked: boolean;
  createdAt: string;
  runs: Run[];
}

export interface Repo {
  name: string;          // folder name, authoritative
  path: string;
  exists: boolean;
  /** true only for the bridge itself */
  isBridge?: boolean;
  /** registered in `sessions/init.md` vs auto-discovered as a sibling folder */
  declared?: boolean;
  /** description from the apps registry (only set on registered repos) */
  description?: string;
  /** current git branch (null = not a git repo or read failed) */
  branch?: string | null;
}

export type GitBranchMode = "current" | "fixed" | "auto-create";
export type GitWorktreeMode = "disabled" | "enabled";
export type GitIntegrationMode = "none" | "auto-merge" | "pull-request";

export interface AppGitSettings {
  branchMode: GitBranchMode;
  fixedBranch: string;
  autoCommit: boolean;
  autoPush: boolean;
  /** (P4) `enabled` runs every spawned child in a private worktree. */
  worktreeMode: GitWorktreeMode;
  /**
   * Integration target branch — used when `integrationMode` is
   * `auto-merge` (local merge) or `pull-request` (devops agent opens
   * a PR/MR). Empty when `integrationMode === "none"`.
   */
  mergeTargetBranch: string;
  /**
   * What the bridge does with the agent's work branch after auto-commit:
   * `none` | `auto-merge` (local) | `pull-request` (gh/glab via devops).
   */
  integrationMode: GitIntegrationMode;
}

/**
 * Per-app verify contract — shell commands the bridge runs after a
 * child agent finishes. P1 surfaces these into the child prompt so the
 * agent self-checks before reporting; P2 will exec them and feed
 * failures into auto-retry.
 */
export interface AppVerify {
  test?: string;
  lint?: string;
  build?: string;
  typecheck?: string;
  format?: string;
}

/**
 * (P2b-2) Per-app opt-in agent-driven quality gates. Both default off
 * because each enabled flag costs an extra LLM spawn per task.
 */
export interface AppQuality {
  critic?: boolean;
  verifier?: boolean;
}

/**
 * (Gap 2) Per-gate retry budgets. Each gate has an independent attempt
 * counter, capped server-side at MAX_RETRY_PER_GATE. Default 1 = legacy
 * single-shot retry per gate.
 */
export interface AppRetry {
  crash?: number;
  verify?: number;
  claim?: number;
  preflight?: number;
  style?: number;
  semantic?: number;
}

export interface App {
  name: string;
  path: string;
  rawPath: string;
  description: string;
  git: AppGitSettings;
  verify: AppVerify;
  /**
   * (P3a) Files always injected into spawned children's prompts.
   * Paths relative to the app root.
   */
  pinnedFiles: string[];
  /**
   * (P3a) Override the default `[lib, utils, hooks, components/ui]`
   * symbol-index scan roots. Empty = use defaults.
   */
  symbolDirs: string[];
  /**
   * (P2b-2) Opt-in agent-driven post-exit quality gates. Empty object
   * = both gates off (the default).
   */
  quality: AppQuality;
  /**
   * (Gap 2) Per-gate retry budgets. Empty / missing = each gate uses
   * the default (1 attempt per gate).
   */
  retry: AppRetry;
}

export interface SessionSummary {
  sessionId: string;
  repo: string;          // folder name the session belongs to (its project dir)
  repoPath: string;      // absolute path on disk, surfaced for full-path grouping
  branch: string | null; // current git branch of the repo (null if not a git tree)
  isBridge: boolean;
  mtime: number;
  size: number;
  preview: string;
  link: { taskId: string; role: string } | null;
}

export const SECTION_ORDER: TaskSection[] = ["TODO", "DOING", "BLOCKED", "DONE — not yet archived"];

export const SECTION_LABEL: Record<TaskSection, string> = {
  TODO: "Todo",
  DOING: "Doing",
  BLOCKED: "Blocked",
  "DONE — not yet archived": "Done",
};

export const STATUS_ORDER: TaskStatus[] = ["todo", "doing", "blocked", "done"];

export const STATUS_LABEL: Record<TaskStatus, string> = {
  todo: "Todo",
  doing: "Doing",
  blocked: "Blocked",
  done: "Done",
};

export type PermissionMode =
  | "default"
  | "acceptEdits"
  | "plan"
  | "auto"
  | "bypassPermissions"
  | "dontAsk";

export type EffortLevel = "low" | "medium" | "high" | "max";

export interface ChatSettings {
  mode?: PermissionMode;
  effort?: EffortLevel;
  model?: string;
}

/**
 * Auto-detect candidate as it travels over the SSE stream. Mirror of
 * `DetectCandidate` in `lib/apps.ts`; lifted here so the dialog can
 * type the parsed `event.data` payloads without importing server code.
 */
export interface DetectCandidate {
  name: string;
  rawPath: string;
  absolutePath: string;
  description: string;
  signals: string[];
  score: number;
  alreadyRegistered: boolean;
  isMonorepoChild: boolean;
}

export type DetectEvent =
  | { type: "started"; roots: string[]; depth: number }
  | { type: "scanning"; root: string }
  | { type: "candidate"; candidate: DetectCandidate }
  | { type: "skipped"; path: string; reason: "not-a-repo" | "already-scanned" | "permission" | "max-dirs" }
  | { type: "done"; candidates: number; alreadyRegistered: number; scanned: number };
