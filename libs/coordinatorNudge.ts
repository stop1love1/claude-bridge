import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  emitCoordinatorNudge,
  readMeta,
  subscribeMetaAll,
  updateRun,
  type MetaChangeEvent,
  type Run,
} from "./meta";
import { isTerminal } from "./runStatus";
import { isAlive } from "./sessionEvents";
import { resumeSessionWithLifecycle } from "./resumeSession";
import { denyTaskToolNames } from "./spawn";
import { BRIDGE_ROOT, SESSIONS_DIR } from "./paths";
import { logError, logInfo, logWarn } from "./log";

const NUDGE_DEBOUNCE_MS = 5_000;
const EVAL_DELAY_MS = 100;
const SUMMARY_NUDGE_MAX_ATTEMPTS = 3;

export function isSummaryMissing(taskId: string): boolean {
  const path = join(SESSIONS_DIR, taskId, "summary.md");
  if (!existsSync(path)) return true;
  try {
    return readFileSync(path, "utf8").trim().length === 0;
  } catch {
    return true;
  }
}

export function isSummaryStale(args: {
  taskId: string;
  parentSessionId: string;
  runs: Run[];
}): boolean {
  const path = join(SESSIONS_DIR, args.taskId, "summary.md");
  if (!existsSync(path)) return false;
  let summaryMtime: number;
  try {
    summaryMtime = statSync(path).mtimeMs;
  } catch {
    return false;
  }
  let latestChildEnd = 0;
  for (const r of args.runs) {
    if (r.parentSessionId !== args.parentSessionId) continue;
    if (!isTerminal(r.status)) continue;
    if (!r.endedAt) continue;
    const t = Date.parse(r.endedAt);
    if (Number.isNaN(t)) continue;
    if (t > latestChildEnd) latestChildEnd = t;
  }
  if (latestChildEnd === 0) return false;
  return latestChildEnd > summaryMtime + 1000;
}

interface NudgeState {
  installed: boolean;
  unsubscribe: (() => void) | null;
  lastNudge: Map<string, number>;
  summaryNudgeAttempts: Map<string, number>;
}

const G = globalThis as unknown as { __bridgeCoordinatorNudge?: NudgeState };
const state: NudgeState = G.__bridgeCoordinatorNudge ?? {
  installed: false,
  unsubscribe: null,
  lastNudge: new Map(),
  summaryNudgeAttempts: new Map(),
};
G.__bridgeCoordinatorNudge = state;

// Lives in the leaf `runStatus` module so routes can import it without
// pulling this module's spawn/lifecycle import cycle into their bundle.
export { isTerminal } from "./runStatus";

export function shouldFinalizeDeferredCoordinator(args: {
  parentSessionId: string;
  runs: Run[];
  isAlive: (sessionId: string) => boolean;
  summaryMissing?: boolean;
  summaryStale?: boolean;
}): boolean {
  const coord = args.runs.find(
    (r) => r.sessionId === args.parentSessionId && r.role === "coordinator",
  );
  if (!coord || coord.status !== "running") return false;
  if (args.isAlive(args.parentSessionId)) return false;
  if (args.summaryMissing === true) return false;
  if (args.summaryStale === true) return false;
  return args.runs.every(
    (r) =>
      r.sessionId === args.parentSessionId ||
      r.parentSessionId !== args.parentSessionId ||
      isTerminal(r.status),
  );
}

export function shouldMarkCoordinatorSummaryBlocked(args: {
  parentSessionId: string;
  runs: Run[];
  isAlive: (sessionId: string) => boolean;
  summaryMissing: boolean;
  summaryNudgeAttempts: number;
}): boolean {
  const coord = args.runs.find(
    (r) => r.sessionId === args.parentSessionId && r.role === "coordinator",
  );
  if (!coord || coord.status !== "running") return false;
  if (args.isAlive(args.parentSessionId)) return false;
  if (!args.summaryMissing) return false;
  if (args.summaryNudgeAttempts < SUMMARY_NUDGE_MAX_ATTEMPTS) return false;
  return args.runs.every(
    (r) =>
      r.sessionId === args.parentSessionId ||
      r.parentSessionId !== args.parentSessionId ||
      isTerminal(r.status),
  );
}

export type NudgeDecision =
  | { kind: "nudge"; children: Run[] }
  | { kind: "skip"; reason: string };

export function decideNudge(args: {
  parentSessionId: string;
  runs: Run[];
  isAlive: (sessionId: string) => boolean;
  lastNudgeAt: number | null;
  now: number;
  summaryMissing?: boolean;
  summaryStale?: boolean;
  summaryNudgeAttempts?: number;
}): NudgeDecision {
  const coordinator = args.runs.find(
    (r) => r.sessionId === args.parentSessionId && r.role === "coordinator",
  );
  if (!coordinator) return { kind: "skip", reason: "no coordinator row" };

  const children = args.runs.filter(
    (r) => r.parentSessionId === args.parentSessionId,
  );
  if (children.length === 0) return { kind: "skip", reason: "no children" };
  if (children.some((r) => !isTerminal(r.status))) {
    return { kind: "skip", reason: "child still running" };
  }

  if (args.isAlive(args.parentSessionId)) {
    return { kind: "skip", reason: "coordinator alive" };
  }

  const summaryMissing = args.summaryMissing ?? true;
  const summaryStale = args.summaryStale ?? false;
  if (!summaryMissing && !summaryStale) {
    return { kind: "skip", reason: "summary already written" };
  }
  const attempts = args.summaryNudgeAttempts ?? 0;
  if (attempts >= SUMMARY_NUDGE_MAX_ATTEMPTS) {
    return { kind: "skip", reason: "summary nudge attempts exhausted" };
  }

  if (args.lastNudgeAt && args.now - args.lastNudgeAt < NUDGE_DEBOUNCE_MS) {
    return { kind: "skip", reason: "debounced" };
  }

  return { kind: "nudge", children };
}

function buildNudgeMessage(args: {
  taskId: string;
  children: Run[];
}): string {
  const lines = args.children.map(
    (r) => `- ${r.role} @ ${r.repo}: ${r.status}`,
  );
  return [
    `Auto-nudge from bridge: every spawned child for task ${args.taskId} has finished.`,
    "",
    "Child states:",
    ...lines,
    "",
    "Read `sessions/" + args.taskId + "/reports/*.md` for the full per-child output, then aggregate per `prompts/coordinator-playbook.md` §5.",
    "If any child is `failed`, decide whether to dispatch a follow-up or surface BLOCKED in your summary.",
    "If everything is `done`, write `sessions/" + args.taskId + "/summary.md` with `READY FOR REVIEW` on the top line and post the same content as your final assistant message — do NOT auto-promote the task to DONE.",
  ].join("\n");
}

function buildBlockedSummary(args: {
  taskId: string;
  attempts: number;
  children: Run[];
}): string {
  const childLines = args.children.map(
    (r) => `- \`${r.role}\` @ \`${r.repo}\` — ${r.status}`,
  );
  return [
    `BLOCKED — coordinator failed to write summary after ${args.attempts} nudge attempt(s)`,
    "",
    "The bridge resumed this coordinator multiple times and it still exited without writing the contracted `summary.md`. The task has been moved to BLOCKED so it shows up as needing your attention instead of silently flipping to DONE with no user-visible output.",
    "",
    "## Children that ran",
    ...(childLines.length > 0 ? childLines : ["- (no children spawned)"]),
    "",
    "## What to do",
    "1. Open the per-child reports under `sessions/" + args.taskId + "/reports/` to see what actually shipped.",
    "2. If the work is good, write your own summary here and tick the task complete in the UI.",
    "3. If something is wrong, re-dispatch from the UI (it will move the task back to TODO and spawn a fresh coordinator).",
    "",
    "_Auto-generated by `libs/coordinatorNudge.ts` when SUMMARY_NUDGE_MAX_ATTEMPTS was reached._",
    "",
  ].join("\n");
}

async function markCoordinatorSummaryBlocked(args: {
  sessionsDir: string;
  taskId: string;
  parentSessionId: string;
  attempts: number;
}): Promise<void> {
  const { sessionsDir, taskId, parentSessionId, attempts } = args;
  try {
    const meta = readMeta(sessionsDir);
    const children = meta?.runs.filter(
      (r) => r.parentSessionId === parentSessionId,
    ) ?? [];

    await updateRun(
      sessionsDir,
      parentSessionId,
      { status: "failed", endedAt: new Date().toISOString() },
      (r) => r.status === "running",
    );

    try {
      const summaryPath = join(sessionsDir, "summary.md");
      writeFileSync(
        summaryPath,
        buildBlockedSummary({ taskId, attempts, children }),
        "utf8",
      );
    } catch (e) {
      logWarn("coordinator-nudge", "could not write synthetic summary.md", {
        taskId,
        error: (e as Error).message,
      });
    }

    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const ts = require("./tasksStore") as typeof import("./tasksStore");
      await ts.updateTask(taskId, { section: "BLOCKED" });
    } catch (e) {
      logWarn("coordinator-nudge", "could not PATCH task section to BLOCKED", {
        taskId,
        error: (e as Error).message,
      });
    }

    logInfo(
      "coordinator-nudge",
      `marked coordinator BLOCKED — summary missing after ${attempts} nudge attempts`,
      { taskId, coordinator: parentSessionId.slice(0, 8) },
    );

    state.summaryNudgeAttempts.delete(parentSessionId);
  } catch (e) {
    logError("coordinator-nudge", "failed to mark coordinator BLOCKED", e, {
      taskId,
      coordinator: parentSessionId.slice(0, 8),
    });
  }
}

async function evaluateAndNudge(
  taskId: string,
  parentSessionId: string,
  trigger = "child-exit",
): Promise<void> {
  const sessionsDir = join(SESSIONS_DIR, taskId);
  const meta = readMeta(sessionsDir);
  if (!meta) return;

  const summaryMissing = isSummaryMissing(taskId);
  const summaryStale = !summaryMissing
    && isSummaryStale({ taskId, parentSessionId, runs: meta.runs });
  const attemptsSoFar = state.summaryNudgeAttempts.get(parentSessionId) ?? 0;

  if (
    shouldMarkCoordinatorSummaryBlocked({
      parentSessionId,
      runs: meta.runs,
      isAlive,
      summaryMissing,
      summaryNudgeAttempts: attemptsSoFar,
    })
  ) {
    await markCoordinatorSummaryBlocked({
      sessionsDir,
      taskId,
      parentSessionId,
      attempts: attemptsSoFar,
    });
    return;
  }

  if (
    shouldFinalizeDeferredCoordinator({
      parentSessionId,
      runs: meta.runs,
      isAlive,
      summaryMissing,
      summaryStale,
    })
  ) {
    try {
      await updateRun(
        sessionsDir,
        parentSessionId,
        { status: "done", endedAt: new Date().toISOString() },
        (r) => r.status === "running",
      );
      logInfo(
        "coordinator-nudge",
        "finalized deferred coordinator DONE flip (process exited, children settled, summary present)",
        { taskId, coordinator: parentSessionId.slice(0, 8) },
      );
    } catch (e) {
      logError("coordinator-nudge", "deferred-DONE flip failed", e, {
        taskId,
        coordinator: parentSessionId.slice(0, 8),
      });
    }
  }

  const metaAfter = readMeta(sessionsDir) ?? meta;

  const now = Date.now();
  const decision = decideNudge({
    parentSessionId,
    runs: metaAfter.runs,
    isAlive,
    lastNudgeAt: state.lastNudge.get(parentSessionId) ?? null,
    now,
    summaryMissing,
    summaryStale,
    summaryNudgeAttempts: state.summaryNudgeAttempts.get(parentSessionId) ?? 0,
  });
  if (decision.kind !== "nudge") {
    if (!summaryMissing && !summaryStale) {
      state.summaryNudgeAttempts.delete(parentSessionId);
    }
    return;
  }

  state.lastNudge.set(parentSessionId, now);
  state.summaryNudgeAttempts.set(
    parentSessionId,
    (state.summaryNudgeAttempts.get(parentSessionId) ?? 0) + 1,
  );

  if (state.lastNudge.size > 256) {
    const cutoff = now - NUDGE_DEBOUNCE_MS * 4;
    for (const [k, t] of state.lastNudge) {
      if (t < cutoff) state.lastNudge.delete(k);
    }
  }
  if (state.summaryNudgeAttempts.size > 256) {
    const keys = Array.from(state.summaryNudgeAttempts.keys());
    for (const k of keys.slice(0, keys.length / 2)) {
      state.summaryNudgeAttempts.delete(k);
    }
  }

  const coordRun = metaAfter.runs.find(
    (r) => r.sessionId === parentSessionId,
  );
  if (coordRun) {
    emitCoordinatorNudge({
      taskId,
      parentSessionId,
      coordinatorRun: coordRun,
      reason: trigger,
    });
  }

  try {
    resumeSessionWithLifecycle({
      cwd: BRIDGE_ROOT,
      sessionId: parentSessionId,
      message: buildNudgeMessage({ taskId, children: decision.children }),
      settings: { mode: "bypassPermissions", disallowedTools: denyTaskToolNames() },
      context: `coordinator-nudge ${taskId}`,
    });
    logInfo(
      "coordinator-nudge",
      `nudged coordinator (${trigger}) — ${decision.children.length} child(ren) settled, summaryMissing=${summaryMissing}`,
      {
        taskId,
        coordinator: parentSessionId.slice(0, 8),
        attempt: state.summaryNudgeAttempts.get(parentSessionId) ?? 0,
      },
    );
  } catch (e) {
    logError("coordinator-nudge", "resume failed", e, {
      taskId,
      coordinator: parentSessionId.slice(0, 8),
    });
  }
}

function onMetaChange(ev: MetaChangeEvent): void {
  if (ev.kind !== "transition" || !ev.run || !ev.sessionId) return;
  if (!isTerminal(ev.run.status)) return;

  let parentId: string | null = null;
  let label: string;
  if (ev.run.role === "coordinator") {
    parentId = ev.sessionId;
    label = "self-exit";
  } else if (ev.run.parentSessionId) {
    parentId = ev.run.parentSessionId;
    label = "child-exit";
  } else {
    return;
  }

  const taskId = ev.taskId;
  const t = setTimeout(() => {
    void evaluateAndNudge(taskId, parentId, label);
  }, EVAL_DELAY_MS);
  if (typeof t === "object" && t !== null && "unref" in t) {
    (t as { unref: () => void }).unref();
  }
}

export function scheduleCoordinatorEvaluation(
  taskId: string,
  parentSessionId: string,
  label = "external",
): void {
  const t = setTimeout(() => {
    void evaluateAndNudge(taskId, parentSessionId, label);
  }, EVAL_DELAY_MS);
  if (typeof t === "object" && t !== null && "unref" in t) {
    (t as { unref: () => void }).unref();
  }
}

function runStartupSweep(): void {
  if (!existsSync(SESSIONS_DIR)) return;
  let ids: string[];
  try {
    ids = readdirSync(SESSIONS_DIR);
  } catch (e) {
    logWarn("coordinator-nudge", "startup sweep: could not list SESSIONS_DIR", {
      error: (e as Error).message,
    });
    return;
  }

  let scheduled = 0;
  for (const taskId of ids) {
    try {
      const dir = join(SESSIONS_DIR, taskId);
      const meta = readMeta(dir);
      if (!meta) continue;
      const coord = meta.runs.find((r) => r.role === "coordinator");
      if (!coord) continue;
      const children = meta.runs.filter(
        (r) => r.parentSessionId === coord.sessionId,
      );
      if (children.length === 0) continue;
      if (children.some((r) => !isTerminal(r.status))) continue;
      if (isAlive(coord.sessionId)) continue;
      const summaryMissing = isSummaryMissing(taskId);
      const summaryStale = !summaryMissing
        && isSummaryStale({
          taskId,
          parentSessionId: coord.sessionId,
          runs: meta.runs,
        });
      if (!summaryMissing && !summaryStale) continue;

      scheduleCoordinatorEvaluation(taskId, coord.sessionId, "startup-sweep");
      scheduled++;
    } catch (e) {
      logWarn("coordinator-nudge", `startup sweep: skipped ${taskId}`, {
        error: (e as Error).message,
      });
    }
  }
  if (scheduled > 0) {
    logInfo("coordinator-nudge", `startup sweep scheduled ${scheduled} stuck coordinator(s)`);
  }
}

export function ensureCoordinatorNudge(): void {
  if (state.installed) return;
  state.installed = true;
  state.unsubscribe = subscribeMetaAll(onMetaChange);
  logInfo("coordinator-nudge", "installed");
  queueMicrotask(() => {
    try {
      runStartupSweep();
    } catch (e) {
      logError("coordinator-nudge", "startup sweep failed", e);
    }
  });
}

export function _resetCoordinatorNudgeForTest(): void {
  if (state.unsubscribe) {
    try { state.unsubscribe(); } catch { }
  }
  state.installed = false;
  state.unsubscribe = null;
  state.lastNudge.clear();
  state.summaryNudgeAttempts.clear();
}
