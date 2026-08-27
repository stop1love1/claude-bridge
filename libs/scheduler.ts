
import { isLockHolder, readLockHolder } from "./processLock";
import { startWorkflowRun, countActivePipelines } from "./pipelineEngine";
import {
  getSchedulerSettings,
  listWorkflows,
  type Workflow,
} from "./workflowStore";
import { autoQueueTick } from "./autoQueue";
import { logError, logInfo } from "./log";

const TICK_MS = 30_000;
const FIRST_TICK_DELAY_MS = 5_000;

interface SchedulerState {
  installed: boolean;
  timer: ReturnType<typeof setInterval> | null;
  ticking: boolean;
  lastTickAt: number | null;
  lastError: string | null;
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
  });


export function dueWorkflows(workflows: Workflow[], nowMs: number): Workflow[] {
  return workflows.filter(
    (w) =>
      w.enabled &&
      w.schedule !== null &&
      w.nextRunAt !== null &&
      nowMs >= w.nextRunAt,
  );
}


async function runCron(nowMs: number): Promise<void> {
  const settings = getSchedulerSettings();
  if (!settings.cronEnabled) return;
  const due = dueWorkflows(listWorkflows(), nowMs);
  for (const wf of due) {
    if (countActivePipelines() >= settings.maxConcurrentRuns) {
      logInfo("scheduler", `at concurrency cap (${settings.maxConcurrentRuns}) — deferring "${wf.name}"`);
      break;
    }
    try {
      const r = await startWorkflowRun(wf.id);
      if (r) logInfo("scheduler", `cron started workflow "${wf.name}" → ${r.taskId}`);
    } catch (e) {
      logError("scheduler", "cron start failed", e, { workflowId: wf.id });
    }
  }
}

async function tick(): Promise<void> {
  if (!isLockHolder()) return;
  if (state.ticking) return;
  state.ticking = true;
  const now = Date.now();
  state.lastTickAt = now;
  try {
    await runCron(now);
    state.lastError = null;
  } catch (e) {
    state.lastError = (e as Error).message;
    logError("scheduler", "tick failed", e);
  }
  try {
    await autoQueueTick();
  } catch (e) {
    logError("scheduler", "auto-queue tick failed", e);
  } finally {
    state.ticking = false;
  }
}

export function ensureScheduler(): void {
  if (state.installed && state.timer !== null) return;
  state.installed = true;

  const timer = setInterval(() => {
    void tick();
  }, TICK_MS);
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
