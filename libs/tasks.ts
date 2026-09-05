export type TaskStatus = "todo" | "doing" | "blocked" | "done";
export type TaskSection = "TODO" | "DOING" | "BLOCKED" | "DONE — not yet archived";

export const SECTION_TODO = "TODO" as const;
export const SECTION_DOING = "DOING" as const;
export const SECTION_BLOCKED = "BLOCKED" as const;
export const SECTION_DONE = "DONE — not yet archived" as const;

export const SECTION_ORDER: readonly TaskSection[] = [
  SECTION_TODO,
  SECTION_DOING,
  SECTION_BLOCKED,
  SECTION_DONE,
];

export interface Task {
  id: string;
  date: string;
  title: string;
  body: string;
  status: TaskStatus;
  section: TaskSection;
  checked: boolean;
  app?: string | null;
  origin?: "manual" | "cron" | "pipeline";
  workflowId?: string | null;
  effort?: "low" | "medium" | "high" | "xhigh" | "max" | "ultracode" | null;
  intakeStatus?: "none" | "planning" | "awaiting-approval" | "approved" | "error" | null;
  createdAt?: string;
  /**
   * How the task gets its coordinator. `immediate` (the default, and what
   * every pre-existing task reads as) spawns on creation; `manual` parks the
   * task in TODO until the operator drags it to DOING, hits Start, or the
   * `scheduledAt` time arrives.
   */
  dispatch?: TaskDispatch;
  /** ISO time at which a waiting TODO task should start on its own. */
  scheduledAt?: string | null;
}

export type TaskDispatch = "immediate" | "manual";

export const SECTION_STATUS: Record<TaskSection, TaskStatus> = {
  TODO: "todo",
  DOING: "doing",
  BLOCKED: "blocked",
  "DONE — not yet archived": "done",
};

const TASK_ID_RE = /^t_\d{8}_\d{3}$/;

export function isValidTaskId(id: unknown): id is string {
  return typeof id === "string" && TASK_ID_RE.test(id);
}

export function generateTaskId(now: Date, existing: string[]): string {
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, "0");
  const d = String(now.getUTCDate()).padStart(2, "0");
  const prefix = `t_${y}${m}${d}_`;
  const max = existing
    .filter((id) => id.startsWith(prefix))
    .map((id) => parseInt(id.slice(prefix.length), 10))
    .reduce((a, b) => Math.max(a, b), 0);
  return `${prefix}${String(max + 1).padStart(3, "0")}`;
}
