export type TaskStatus = "todo" | "doing" | "blocked" | "done";
export type TaskSection = "TODO" | "DOING" | "BLOCKED" | "DONE — not yet archived";

export interface Task {
  id: string;
  date: string;          // YYYY-MM-DD
  title: string;
  body: string;          // everything after the title line, excluding blank tail
  status: TaskStatus;
  section: TaskSection;
  checked: boolean;      // [x] vs [ ]
  /** Target app name; `null` means "auto" (coordinator decides). */
  app?: string | null;
}

export const SECTION_STATUS: Record<TaskSection, TaskStatus> = {
  TODO: "todo",
  DOING: "doing",
  BLOCKED: "blocked",
  "DONE — not yet archived": "done",
};

/**
 * Strict task ID format: `t_YYYYMMDD_NNN`. Used as both the slug and a
 * trust gate before any path join under `SESSIONS_DIR` — anything that
 * doesn't match this regex must be rejected to prevent traversal
 * (`../`, `/`, `\`, drive letters, null bytes, …).
 */
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
