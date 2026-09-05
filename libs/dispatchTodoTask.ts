import { join } from "node:path";
import { readMeta, setIntake } from "./meta";
import { SESSIONS_DIR } from "./paths";
import { getTask, updateTask } from "./tasksStore";
import { spawnCoordinatorForTask } from "./coordinator";
import { readPlanGateConfig } from "./planGateConfig";
import { SECTION_DOING, SECTION_TODO } from "./tasks";
import { withInFlight } from "./inFlight";
import { logError, logInfo, logWarn } from "./log";

export type DispatchResult =
  | { action: "spawned"; sessionId: string }
  | { action: "skipped"; reason: string }
  | { action: "failed"; reason: string };

/**
 * Start a task that has been waiting in TODO: a hand-controlled draft the
 * operator just dragged to DOING or clicked Start on, or one whose
 * `scheduledAt` has arrived.
 *
 * Accepts TODO and DOING (the board moves the card before it asks us to
 * dispatch; the coordinator PATCHes DOING itself anyway). Refuses when any
 * run is still live. Always spawns a fresh coordinator — an earlier one that
 * was killed is history the new one reads from meta.json.
 *
 * Per-task in-flight gate: the 30s scheduler tick and a drag can land
 * together, and only one of them may spawn.
 */
export async function dispatchTodoTask(taskId: string): Promise<DispatchResult> {
  const r = await withInFlight("task:dispatch", taskId, () => dispatchInner(taskId));
  return r ?? { action: "skipped", reason: "dispatch already in flight" };
}

async function dispatchInner(taskId: string): Promise<DispatchResult> {
  const meta = readMeta(join(SESSIONS_DIR, taskId));
  if (!meta) return { action: "skipped", reason: "task not found" };
  if (meta.taskChecked) return { action: "skipped", reason: "task is completed" };
  if (meta.taskSection !== SECTION_TODO && meta.taskSection !== SECTION_DOING) {
    return { action: "skipped", reason: `task is in ${meta.taskSection}` };
  }
  if (meta.runs.some((r) => r.status === "running" || r.status === "queued")) {
    return { action: "skipped", reason: "run already live" };
  }

  const task = getTask(taskId);
  if (!task) return { action: "skipped", reason: "task not found" };

  // The create route opens the plan gate for immediately-dispatched tasks;
  // a parked task gets it here, so a waiting card doesn't read as "planning"
  // for hours before anything runs. Dispatch is always an operator action
  // (drag, Start, or a schedule the operator set).
  const dir = join(SESSIONS_DIR, taskId);
  const intakeStatus = meta.intake?.status ?? "none";
  if (intakeStatus === "none" && readPlanGateConfig().operatorEnabled) {
    try {
      await setIntake(dir, { status: "planning", submittedBy: { kind: "operator", label: "operator" } });
    } catch (err) {
      logWarn("dispatch", "plan-gate init failed (non-fatal)", { taskId, error: (err as Error)?.message ?? String(err) });
    }
  }

  let sessionId: string | null;
  try {
    sessionId = await spawnCoordinatorForTask(task);
  } catch (err) {
    logError("dispatch", "coordinator spawn threw", err, { taskId });
    return { action: "failed", reason: (err as Error)?.message ?? String(err) };
  }
  if (!sessionId) return { action: "failed", reason: "coordinator spawn returned null" };

  if (meta.scheduledAt) {
    try { await updateTask(taskId, { scheduledAt: null }); }
    catch (err) { logError("dispatch", "failed to clear scheduledAt after spawn", err, { taskId }); }
  }
  logInfo("dispatch", `started ${taskId}`, { taskId, sessionId });
  return { action: "spawned", sessionId };
}
