// Domain types used by the SPA. The auto-generated `schema.ts` carries
// the request/path surface but its response bodies are still v0.1
// `OkResponse` placeholders, so we re-declare the concrete shapes the
// Go bridge actually emits (mirrors internal/meta/{meta,tasks}.go and
// the Next libs/meta.ts the bridge round-trips).

export type RunStatus =
  | "queued"
  | "running"
  | "done"
  | "failed"
  | "stale";

export type TaskStatus = "todo" | "doing" | "blocked" | "done";

export type TaskSection =
  | "TODO"
  | "DOING"
  | "BLOCKED"
  | "DONE — not yet archived";

export const SECTIONS: TaskSection[] = [
  "TODO",
  "DOING",
  "BLOCKED",
  "DONE — not yet archived",
];

export interface Run {
  sessionId: string;
  role: string;
  repo: string;
  status: RunStatus;
  startedAt: string | null;
  endedAt: string | null;
  parentSessionId?: string | null;
  retryOf?: string | null;
  retryAttempt?: number | null;
  worktreePath?: string | null;
  worktreeBranch?: string | null;
  worktreeBaseBranch?: string | null;
  exitCode?: number | null;
  speculativeGroup?: string | null;
  speculativeOutcome?: string | null;
}

export interface TaskMeta {
  taskId: string;
  taskTitle: string;
  taskBody: string;
  taskStatus: TaskStatus;
  taskSection: TaskSection;
  taskChecked: boolean;
  taskApp?: string | null;
  createdAt: string;
  runs: Run[];
}

export interface TaskMetaList {
  tasks: TaskMeta[];
}

export interface HealthResponse {
  status: "ok";
  version?: string;
  uptime?: number;
}

export interface AppEntry {
  name: string;
  path?: string;
  branchMode?: "current" | "fixed" | "auto-create";
  fixedBranch?: string;
  autoCommit?: boolean;
  autoPush?: boolean;
}

export interface AppsResponse {
  apps: AppEntry[];
}

export interface UsageResponse {
  totals?: {
    inputTokens?: number;
    outputTokens?: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
    cost?: number;
  };
  perTask?: Record<string, unknown>;
}
