import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { BRIDGE_STATE_DIR, SESSIONS_DIR } from "./paths";
import { writeJsonAtomic } from "./atomicWrite";
import { listTasks } from "./tasksStore";
import { readMeta } from "./meta";
import type { Meta } from "./meta";
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

export function _resetForTests(): void {
  state.data = { ...DEFAULTS };
  state.loaded = true;
}

export const _internal = { CONFIG_FILE };


const AUTO_QUEUE_SETTLE_MS = 120_000;

export function pickNextTodoTask(tasks: Task[], runCountById: Map<string, number>): Task | null {
  const now = Date.now();
  const eligible = tasks.filter((t) => {
    if (t.section !== "TODO") return false;
    if ((runCountById.get(t.id) ?? 0) > 0) return false;
    const intake = t.intakeStatus ?? "none";
    if (intake !== "none") return false;
    if (t.createdAt) {
      const createdMs = Date.parse(t.createdAt);
      if (Number.isFinite(createdMs) && now - createdMs < AUTO_QUEUE_SETTLE_MS) return false;
    }
    return true;
  });
  if (eligible.length === 0) return null;
  eligible.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return eligible[0];
}

function metaLooksDispatchable(meta: Meta | null): boolean {
  if (!meta) return false;
  if (meta.taskSection !== "TODO") return false;
  if (meta.runs.length > 0) return false;
  const intakeStatus = meta.intake?.status ?? "none";
  if (intakeStatus !== "none") return false;
  return true;
}


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

  const freshMeta = readMeta(join(SESSIONS_DIR, next.id));
  if (!metaLooksDispatchable(freshMeta)) {
    logInfo("autoQueue", `skipped ${next.id}: no longer eligible at dispatch time`, { taskId: next.id });
    return;
  }

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
