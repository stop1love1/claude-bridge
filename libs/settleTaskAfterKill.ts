import { join } from "node:path";
import { readMeta } from "./meta";
import { SESSIONS_DIR } from "./paths";
import { updateTask } from "./tasksStore";
import { SECTION_BLOCKED, SECTION_DOING, SECTION_TODO, type TaskSection } from "./tasks";
import { logInfo } from "./log";

/**
 * After an operator kill, decide whether the task still belongs in DOING.
 *
 * A coordinator that was killed (its run is `cancelled`) with nothing else
 * alive leaves the task with no one driving it. Left in DOING it reads as
 * in-progress forever. So:
 *
 * - no child agent was ever dispatched → back to TODO (nothing happened yet);
 * - children exist → BLOCKED (work started, cannot finish on its own).
 *
 * Anything else — a live run, a coordinator that finished normally and
 * parked the task for review, a task not in DOING — is left untouched.
 *
 * Returns the section the task was moved to, or null when nothing changed.
 */
export async function settleTaskAfterKill(taskId: string): Promise<TaskSection | null> {
  const meta = readMeta(join(SESSIONS_DIR, taskId));
  if (!meta) return null;
  if (meta.taskChecked || meta.taskSection !== SECTION_DOING) return null;

  const runs = meta.runs ?? [];
  if (runs.some((r) => r.status === "running" || r.status === "queued")) return null;

  const lastCoordinator = [...runs].reverse().find((r) => r.role === "coordinator");
  if (!lastCoordinator || lastCoordinator.status !== "cancelled") return null;

  const hadChildren = runs.some((r) => r.role !== "coordinator");
  const target: TaskSection = hadChildren ? SECTION_BLOCKED : SECTION_TODO;

  const updated = await updateTask(taskId, { section: target });
  if (!updated) return null;
  logInfo("kill", `coordinator killed with nothing live — parked ${taskId} in ${target}`);
  return target;
}
