/**
 * Autonomous scheduler — the engine behind the "Quy trình" feature.
 *
 * One interval tick (default 30s) drives two things on the SINGLE bridge
 * process that holds the advisory lock:
 *
 *   1. CRON — for every enabled workflow whose `nextRunAt` has passed,
 *      mint a task (auto-flagged) and advance its schedule.
 *   2. AUTO-QUEUE — pump `auto`-flagged TODO tasks into DOING and spawn a
 *      coordinator for each, oldest-first, up to the global concurrency
 *      cap (counted as live coordinators across ALL tasks).
 *
 * Cron-minted tasks are created with `auto: true`, so the SAME auto-queue
 * pump dispatches them — one dispatch path, naturally rate-limited by the
 * cap.
 *
 * Guardrails:
 *   - Only the process-lock holder ticks (`isLockHolder`), so a second
 *     bridge booted against the same SESSIONS_DIR never double-dispatches.
 *   - Concurrency cap bounds spawns; the review gate is untouched — the
 *     scheduler NEVER sets section=DONE, only TODO→DOING.
 *   - A per-task dispatch cooldown stops a persistently-failing spawn from
 *     being retried every tick.
 *   - HMR-safe: state + the timer live on `globalThis`, installed once.
 *
 * The decision logic (`dueWorkflows`, `planAutoDispatch`) is pure and
 * unit-tested; the tick wires it to the real stores + spawn path.
 */

import { join } from "node:path";
import { SESSIONS_DIR } from "./paths";
import { isLockHolder, readLockHolder } from "./processLock";
import { takeRunCensus } from "./runCensus";
import { listTasks, createTask, updateTask } from "./tasksStore";
import { spawnCoordinatorForTask } from "./coordinator";
import {
  getSchedulerSettings,
  listWorkflows,
  recordWorkflowFire,
  type SchedulerSettings,
  type Workflow,
} from "./workflowStore";
import {
  getDetectSource,
  heuristicDetector,
  loadDetectInput,
  writeScopeCache,
} from "./detect";
import { detectWithLLM } from "./detect/llm";
import { logError, logInfo, logWarn } from "./log";
import type { Task } from "./tasks";

const TICK_MS = 30_000;
/** Don't re-attempt a task whose dispatch just failed for this long. */
const DISPATCH_RETRY_COOLDOWN_MS = 5 * 60_000;
/** Delay before the first tick so server boot finishes (and the lock is written). */
const FIRST_TICK_DELAY_MS = 5_000;

interface SchedulerState {
  installed: boolean;
  timer: ReturnType<typeof setInterval> | null;
  ticking: boolean;
  lastTickAt: number | null;
  lastError: string | null;
  /** taskId → last dispatch-attempt epoch ms (failure cooldown). */
  lastDispatchAttempt: Map<string, number>;
}

const G = globalThis as unknown as { __bridgeScheduler?: SchedulerState };
const state: SchedulerState =
  G.__bridgeScheduler ??
  (G.__bridgeScheduler = {
    installed: false,
    timer: null,
    ticking: false,
    lastTickAt: null,
    lastError: null,
    lastDispatchAttempt: new Map(),
  });

// ── Pure decision logic (unit-tested) ─────────────────────────────────

/** Workflows that are enabled and whose next fire time has arrived. */
export function dueWorkflows(workflows: Workflow[], nowMs: number): Workflow[] {
  return workflows.filter(
    (w) => w.enabled && w.nextRunAt !== null && nowMs >= w.nextRunAt,
  );
}

/**
 * Decide which candidate tasks to dispatch this tick. `candidates` must
 * already be filtered (TODO + auto + no live coordinator + off cooldown)
 * and ordered oldest-first. Returns the prefix that fits the open slots.
 */
export function planAutoDispatch(args: {
  settings: SchedulerSettings;
  busyCount: number;
  candidates: Task[];
}): Task[] {
  const { settings, busyCount, candidates } = args;
  if (!settings.autoDispatchEnabled) return [];
  const slots = settings.maxConcurrentCoordinators - busyCount;
  if (slots <= 0) return [];
  return candidates.slice(0, slots);
}

// ── Side-effecting tick ───────────────────────────────────────────────

/** Run the per-task detect pass (heuristic now, LLM upgrade in bg) so the
 *  coordinator prompt reads a populated scope — mirrors POST /api/tasks. */
async function primeDetect(task: Task): Promise<void> {
  try {
    const sessionsDir = join(SESSIONS_DIR, task.id);
    const detectInput = loadDetectInput({
      taskBody: task.body,
      taskTitle: task.title,
      pinnedRepo: task.app ?? null,
    });
    const baseline = await heuristicDetector.detect(detectInput);
    await writeScopeCache(sessionsDir, baseline);
    const mode = getDetectSource();
    if (mode === "auto" || mode === "llm") {
      void (async () => {
        try {
          const upgraded = await detectWithLLM(detectInput);
          if (upgraded) await writeScopeCache(sessionsDir, upgraded);
        } catch (err) {
          logWarn("scheduler", "background LLM detect upgrade failed", {
            taskId: task.id,
            error: (err as Error).message,
          });
        }
      })();
    }
  } catch (err) {
    logWarn("scheduler", "detect prime failed (non-fatal)", {
      taskId: task.id,
      error: (err as Error).message,
    });
  }
}

/** Dispatch one auto task: detect → spawn coordinator → move TODO→DOING.
 *  Returns true on success (a live coordinator now owns the task). */
async function dispatchAutoTask(task: Task): Promise<boolean> {
  await primeDetect(task);
  const sessionId = await spawnCoordinatorForTask({
    id: task.id,
    title: task.title,
    body: task.body,
    app: task.app ?? null,
  }).catch((err) => {
    logError("scheduler", "spawnCoordinatorForTask threw", err, { taskId: task.id });
    return null;
  });
  if (!sessionId) return false;
  // Reflect "being worked" on the board immediately. The coordinator's
  // own TODO→DOING PATCH then becomes an idempotent no-op. NEVER DONE —
  // the review gate stays with the user.
  await updateTask(task.id, { section: "DOING" }).catch((err) => {
    logWarn("scheduler", "TODO→DOING flip failed (coordinator will retry)", {
      taskId: task.id,
      error: (err as Error).message,
    });
  });
  return true;
}

async function runCron(nowMs: number): Promise<void> {
  const due = dueWorkflows(listWorkflows(), nowMs);
  for (const wf of due) {
    try {
      const task = createTask({
        title: wf.title,
        body: wf.body,
        app: wf.app,
        auto: true,
        origin: "cron",
        workflowId: wf.id,
      });
      recordWorkflowFire(wf.id, task.id, nowMs);
      logInfo("scheduler", `cron fired: minted ${task.id} from workflow ${wf.id}`);
    } catch (err) {
      logError("scheduler", "cron mint failed", err, { workflowId: wf.id });
    }
  }
}

async function runAutoQueue(nowMs: number): Promise<void> {
  const settings = getSchedulerSettings();
  if (!settings.autoDispatchEnabled) return;

  const census = takeRunCensus();
  const busy = new Set(census.busyTaskIds);

  const candidates = listTasks()
    .filter((t) => t.section === "TODO" && t.auto && !busy.has(t.id))
    .filter((t) => {
      const last = state.lastDispatchAttempt.get(t.id);
      return last === undefined || nowMs - last >= DISPATCH_RETRY_COOLDOWN_MS;
    })
    // listTasks() is newest-first by id; FIFO wants oldest-first.
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const toDispatch = planAutoDispatch({
    settings,
    busyCount: census.liveCoordinatorTasks,
    candidates,
  });

  for (const task of toDispatch) {
    state.lastDispatchAttempt.set(task.id, nowMs);
    const ok = await dispatchAutoTask(task);
    if (ok) {
      logInfo("scheduler", `auto-dispatched ${task.id}`);
    } else {
      logWarn("scheduler", `auto-dispatch failed for ${task.id} (cooldown ${DISPATCH_RETRY_COOLDOWN_MS / 1000}s)`);
    }
  }

  // Garbage-collect cooldown entries for tasks that no longer exist or
  // already left TODO, so the map can't grow unbounded.
  if (state.lastDispatchAttempt.size > 200) {
    const liveTodo = new Set(listTasks().filter((t) => t.section === "TODO").map((t) => t.id));
    for (const id of state.lastDispatchAttempt.keys()) {
      if (!liveTodo.has(id)) state.lastDispatchAttempt.delete(id);
    }
  }
}

async function tick(): Promise<void> {
  // Only the singleton lock-holder performs side effects.
  if (!isLockHolder()) return;
  if (state.ticking) return; // a previous long tick is still running
  state.ticking = true;
  const now = Date.now();
  state.lastTickAt = now;
  try {
    await runCron(now);
    await runAutoQueue(now);
    state.lastError = null;
  } catch (err) {
    state.lastError = (err as Error).message;
    logError("scheduler", "tick failed", err);
  } finally {
    state.ticking = false;
  }
}

/** Idempotent, HMR-safe installer — call once from instrumentation. */
export function ensureScheduler(): void {
  if (state.installed) return;
  state.installed = true;

  const timer = setInterval(() => {
    void tick();
  }, TICK_MS);
  // Don't keep the event loop alive on our account.
  if (typeof timer === "object" && timer !== null && "unref" in timer) {
    (timer as { unref: () => void }).unref();
  }
  state.timer = timer;

  const first = setTimeout(() => {
    void tick();
  }, FIRST_TICK_DELAY_MS);
  if (typeof first === "object" && first !== null && "unref" in first) {
    (first as { unref: () => void }).unref();
  }

  logInfo("scheduler", `installed (tick every ${TICK_MS / 1000}s)`);
}

export interface SchedulerStatus {
  installed: boolean;
  isLockHolder: boolean;
  lastTickAt: string | null;
  lastError: string | null;
  tickIntervalMs: number;
  holder: { pid: number; bootAt: number; uptimeMs: number } | null;
}

/** Snapshot for the 24/7 status panel. */
export function getSchedulerStatus(): SchedulerStatus {
  const holderRec = readLockHolder();
  return {
    installed: state.installed,
    isLockHolder: isLockHolder(),
    lastTickAt: state.lastTickAt ? new Date(state.lastTickAt).toISOString() : null,
    lastError: state.lastError,
    tickIntervalMs: TICK_MS,
    holder: holderRec
      ? { pid: holderRec.pid, bootAt: holderRec.bootAt, uptimeMs: Date.now() - holderRec.bootAt }
      : null,
  };
}
