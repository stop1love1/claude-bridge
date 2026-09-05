import { listTasks } from "./tasksStore";
import { dispatchTodoTask } from "./dispatchTodoTask";
import { SECTION_TODO, type Task } from "./tasks";
import { logError, logInfo } from "./log";

/** TODO tasks whose `scheduledAt` is at or before `nowMs`. Pure. */
export function dueScheduledTasks(tasks: Task[], nowMs: number): Task[] {
  return tasks.filter((t) => {
    if (t.checked || t.section !== SECTION_TODO) return false;
    if (!t.scheduledAt) return false;
    const at = Date.parse(t.scheduledAt);
    return Number.isFinite(at) && at <= nowMs;
  });
}

/** Scheduler hook: start every waiting task whose time has come. */
export async function scheduledStartTick(nowMs: number = Date.now()): Promise<void> {
  const due = dueScheduledTasks(listTasks(), nowMs);
  for (const t of due) {
    try {
      const r = await dispatchTodoTask(t.id);
      if (r.action === "spawned") {
        logInfo("scheduled-start", `started ${t.id} (scheduled for ${t.scheduledAt})`, { taskId: t.id });
      } else {
        logInfo("scheduled-start", `${t.id} not started: ${r.reason}`, { taskId: t.id });
      }
    } catch (err) {
      logError("scheduled-start", "dispatch threw", err, { taskId: t.id });
    }
  }
}
