/**
 * Auto-queue — autonomous TODO dispatch.
 *
 * Off by default (`{enabled:false, maxConcurrent:1}`): zero behavior
 * change until an operator opts in via Settings. When enabled, the
 * scheduler's 30s tick (`libs/scheduler.ts`) calls `autoQueueTick()` on
 * the process-lock holder only. Each tick:
 *
 *   1. Count "active" coordinator runs (status `running` OR `queued`,
 *      role `coordinator`) across ALL tasks — `queued` is included so a
 *      coordinator that was just spawned this tick, but hasn't reached
 *      `running` yet (see the `appendRun` → spawn → `updateRun` sequence
 *      in `spawnCoordinatorForTask`), still counts against the cap and
 *      prevents a double-dispatch on the very next tick.
 *   2. If that count is under `maxConcurrent`, pick the OLDEST `TODO`
 *      task with zero runs and no intake in progress (`intakeStatus`
 *      absent or `"none"` — a task mid-planning/awaiting-approval must
 *      not be yanked into autonomous dispatch).
 *   3. Spawn a coordinator for it via `spawnCoordinatorForTask` — the
 *      same path `/retry` uses — which flips the task TODO → DOING
 *      through the normal `appendRun`/`updateRun` lifecycle.
 *
 * One spawn per tick, maximum. Never touches BLOCKED/DOING/DONE tasks.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { BRIDGE_STATE_DIR, SESSIONS_DIR } from "./paths";
import { writeJsonAtomic } from "./atomicWrite";
import { listTasks } from "./tasksStore";
import { readMeta } from "./meta";
import { spawnCoordinatorForTask } from "./coordinator";
import { logError, logInfo } from "./log";
import type { Task } from "./tasks";

export interface AutoQueueConfig {
  enabled: boolean;
  maxConcurrent: number;
}

const CONFIG_FILE = join(BRIDGE_STATE_DIR, "auto-queue.json");
const DEFAULTS: AutoQueueConfig = { enabled: false, maxConcurrent: 1 };

interface State {
  data: AutoQueueConfig;
  loaded: boolean;
}
const G = globalThis as unknown as { __bridgeAutoQueueConfig?: State };
const state: State =
  G.__bridgeAutoQueueConfig ?? (G.__bridgeAutoQueueConfig = { data: { ...DEFAULTS }, loaded: false });

function clampMaxConcurrent(n: unknown): number {
  const v = Math.floor(Number(n));
  return Number.isFinite(v) ? Math.max(1, Math.min(20, v)) : DEFAULTS.maxConcurrent;
}

function normalize(c: AutoQueueConfig): AutoQueueConfig {
  return { enabled: !!c.enabled, maxConcurrent: clampMaxConcurrent(c.maxConcurrent) };
}

function load(): void {
  if (state.loaded) return;
  try {
    if (existsSync(CONFIG_FILE)) {
      const parsed = JSON.parse(readFileSync(CONFIG_FILE, "utf8")) as Partial<AutoQueueConfig>;
      state.data = normalize({ ...DEFAULTS, ...parsed });
    }
  } catch {
    state.data = { ...DEFAULTS };
  }
  state.loaded = true;
}

export function readAutoQueueConfig(): AutoQueueConfig {
  load();
  return { ...state.data };
}

export function writeAutoQueueConfig(patch: Partial<AutoQueueConfig>): AutoQueueConfig {
  load();
  state.data = normalize({ ...state.data, ...patch });
  writeJsonAtomic(CONFIG_FILE, state.data);
  return { ...state.data };
}

/** Test-only: reset to defaults without touching disk. */
export function _resetForTests(): void {
  state.data = { ...DEFAULTS };
  state.loaded = true;
}

export const _internal = { CONFIG_FILE };

// ── Pure decision logic (unit-tested) ───────────────────────────────────

/**
 * Oldest `TODO` task with zero runs and no intake in progress. Stable
 * order by task id — `t_YYYYMMDD_NNN` is lexicographically sortable, so
 * a plain string sort is chronological. `runCountById` supplies the run
 * count per task id (from `meta.runs.length`); tasks missing from the
 * map are treated as having zero runs (shouldn't happen in practice —
 * every task has a meta.json — but fails safe rather than throwing).
 * Returns `null` when nothing qualifies.
 */
export function pickNextTodoTask(tasks: Task[], runCountById: Map<string, number>): Task | null {
  const eligible = tasks.filter((t) => {
    if (t.section !== "TODO") return false;
    if ((runCountById.get(t.id) ?? 0) > 0) return false;
    const intake = t.intakeStatus ?? "none";
    if (intake !== "none") return false;
    return true;
  });
  if (eligible.length === 0) return null;
  eligible.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return eligible[0];
}

// ── Tick ─────────────────────────────────────────────────────────────

/**
 * Scheduler entry point — call once per tick from the process-lock
 * holder (see `libs/scheduler.ts`). No-ops immediately when auto-queue
 * is disabled (the default), so wiring this into the tick is inert
 * until an operator flips the setting on.
 */
export async function autoQueueTick(): Promise<void> {
  const cfg = readAutoQueueConfig();
  if (!cfg.enabled) return;

  const tasks = listTasks();
  let activeCoordinators = 0;
  const runCountById = new Map<string, number>();

  for (const t of tasks) {
    const meta = readMeta(join(SESSIONS_DIR, t.id));
    if (!meta) continue;
    runCountById.set(t.id, meta.runs.length);
    for (const r of meta.runs) {
      if (r.role === "coordinator" && (r.status === "running" || r.status === "queued")) {
        activeCoordinators += 1;
      }
    }
  }

  if (activeCoordinators >= cfg.maxConcurrent) return;

  const next = pickNextTodoTask(tasks, runCountById);
  if (!next) return;

  try {
    const sessionId = await spawnCoordinatorForTask(next);
    if (sessionId) {
      logInfo("autoQueue", `dispatched ${next.id}`, { taskId: next.id, sessionId });
    } else {
      logError("autoQueue", `spawn returned null for ${next.id}`, undefined, { taskId: next.id });
    }
  } catch (e) {
    logError("autoQueue", "spawn failed", e, { taskId: next.id });
  }
}
