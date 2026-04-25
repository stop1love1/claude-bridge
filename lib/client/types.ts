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

export interface App {
  name: string;
  path: string;
  rawPath: string;
  description: string;
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
