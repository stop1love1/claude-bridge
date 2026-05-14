/**
 * Auto-nudge an idle coordinator when its children settle.
 *
 * The bridge / coordinator wire was poll-only: the coordinator had to
 * spin a `curl GET /api/tasks/<id>/meta` loop or schedule a wakeup to
 * notice when a child finished. In practice coordinators tend to spawn
 * children, schedule a wakeup, and go idle — and if the wakeup fires
 * before the children finish (or after, but with no children left to
 * wait on), nothing brings the coordinator back. The user had to chat
 * "ping" to manually re-attach a turn.
 *
 * This module subscribes once at server boot to the global meta-change
 * stream. Whenever a run transitions to a terminal state (`done` /
 * `failed` / `stale`), we ask: was this run a coordinator's child? Are
 * all of that coordinator's children now terminal? Is the coordinator
 * process currently idle (no live claude subprocess attached)? If yes
 * to all three, we resume the coordinator with a short prompt and a
 * one-shot summary of which children settled. Same fan-out path as the
 * `/api/tasks/<id>/continue` button — just triggered by the bridge
 * instead of the user.
 *
 * Guards:
 *   - skip when the finished run has no `parentSessionId` (bridge-spawned
 *     coordinator, no parent to nudge)
 *   - skip when the coordinator process is alive (`isAlive(parentId)`) —
 *     it'll see the new state itself on its next polling tick / wakeup
 *   - skip when any sibling child is still queued/running (a retry that
 *     just respawned would put a fresh `running` row in meta; the next
 *     terminal transition re-evaluates)
 *   - per-coordinator debounce of NUDGE_DEBOUNCE_MS so a burst of
 *     near-simultaneous child exits only nudges once
 *   - 250 ms delay before evaluating, so a synchronous retry-spawn that
 *     fires from the same lifecycle exit handler can land its `queued`
 *     row before we see "all terminal"
 */
import { join } from "node:path";
import {
  readMeta,
  subscribeMetaAll,
  updateRun,
  type MetaChangeEvent,
  type Run,
  type RunStatus,
} from "./meta";
import { isAlive } from "./sessionEvents";
import { resumeSessionWithLifecycle } from "./resumeSession";
import { BRIDGE_ROOT, SESSIONS_DIR } from "./paths";
import { logError, logInfo } from "./log";

const NUDGE_DEBOUNCE_MS = 5_000;
const EVAL_DELAY_MS = 250;

interface NudgeState {
  installed: boolean;
  unsubscribe: (() => void) | null;
  /** coordinator sessionId → epoch-ms of the last nudge we sent. */
  lastNudge: Map<string, number>;
}

const G = globalThis as unknown as { __bridgeCoordinatorNudge?: NudgeState };
const state: NudgeState = G.__bridgeCoordinatorNudge ?? {
  installed: false,
  unsubscribe: null,
  lastNudge: new Map(),
};
G.__bridgeCoordinatorNudge = state;

function isTerminal(s: RunStatus): boolean {
  return s === "done" || s === "failed" || s === "stale";
}

/**
 * Pure decision: should the deferred coordinator DONE flip happen now?
 *
 * Returns true iff the coordinator is in the deferred-`running`
 * state from `runLifecycle.succeedRun` AND the conditions to finalize
 * have been reached: process is gone, every child terminal.
 */
export function shouldFinalizeDeferredCoordinator(args: {
  parentSessionId: string;
  runs: Run[];
  isAlive: (sessionId: string) => boolean;
}): boolean {
  const coord = args.runs.find(
    (r) => r.sessionId === args.parentSessionId && r.role === "coordinator",
  );
  if (!coord || coord.status !== "running") return false;
  if (args.isAlive(args.parentSessionId)) return false;
  return args.runs.every(
    (r) =>
      r.sessionId === args.parentSessionId ||
      r.parentSessionId !== args.parentSessionId ||
      isTerminal(r.status),
  );
}

/**
 * Pure decision: should we nudge the coordinator right now?
 *
 * Extracted so tests can exercise the decision matrix without spinning
 * up the full meta + spawn machinery. The runtime `evaluateAndNudge`
 * just feeds in the live state plus an `isAlive` callback and acts on
 * the verdict.
 */
export type NudgeDecision =
  | { kind: "nudge"; children: Run[] }
  | { kind: "skip"; reason: string };

export function decideNudge(args: {
  parentSessionId: string;
  runs: Run[];
  isAlive: (sessionId: string) => boolean;
  /** Last nudge timestamp for this coordinator (null if none yet). */
  lastNudgeAt: number | null;
  /** Now. Tests pass a fixed value for deterministic debounce assertions. */
  now: number;
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

  if (args.lastNudgeAt && args.now - args.lastNudgeAt < NUDGE_DEBOUNCE_MS) {
    return { kind: "skip", reason: "debounced" };
  }

  return { kind: "nudge", children };
}

/**
 * Decide whether `ev` is a terminal transition we care about.
 * Filters out coordinator-self transitions (no need to nudge yourself)
 * and runs without a parentSessionId.
 */
function isChildTerminalTransition(ev: MetaChangeEvent): ev is MetaChangeEvent & {
  run: Run;
  sessionId: string;
} {
  if (ev.kind !== "transition") return false;
  if (!ev.run || !ev.sessionId) return false;
  if (!isTerminal(ev.run.status)) return false;
  if (ev.run.role === "coordinator") return false;
  if (!ev.run.parentSessionId) return false;
  return true;
}

/**
 * Build the one-shot prompt the bridge sends into the resumed
 * coordinator session. Short by design — the coordinator already has
 * the task context in its transcript; we just hand it the diff since
 * its last turn so it can decide whether to dispatch follow-ups or
 * finalize.
 */
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

async function evaluateAndNudge(taskId: string, parentSessionId: string): Promise<void> {
  const sessionsDir = join(SESSIONS_DIR, taskId);
  const meta = readMeta(sessionsDir);
  if (!meta) return;

  // 2b — finalize the deferred coordinator status flip. When the
  // coordinator's process exited cleanly but `wireRunLifecycle` left it
  // as `running` because children were still active (see the
  // `isCoordWithActiveChildren` branch in `runLifecycle.succeedRun`),
  // this is the moment to honor the deferred flip: process is gone
  // (`!isAlive`) AND every child has now reached a terminal state.
  // Without this, the coordinator row would stay "running" forever
  // when no further nudge / resume happens (e.g. all children finished
  // before the coordinator exited its turn).
  if (
    shouldFinalizeDeferredCoordinator({
      parentSessionId,
      runs: meta.runs,
      isAlive,
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
        "finalized deferred coordinator DONE flip (process exited, children settled)",
        { taskId, coordinator: parentSessionId.slice(0, 8) },
      );
    } catch (e) {
      logError("coordinator-nudge", "deferred-DONE flip failed", e, {
        taskId,
        coordinator: parentSessionId.slice(0, 8),
      });
    }
  }

  // Re-read meta after the potential flip so the nudge decision sees
  // the latest coordinator status (otherwise decideNudge would still
  // observe `running` and skip via the "coordinator alive" guard —
  // wait, the guard checks `isAlive`, not status. But re-reading is
  // cheap and keeps the next decision consistent if more flips land.)
  const metaAfter = readMeta(sessionsDir) ?? meta;

  const now = Date.now();
  const decision = decideNudge({
    parentSessionId,
    runs: metaAfter.runs,
    isAlive,
    lastNudgeAt: state.lastNudge.get(parentSessionId) ?? null,
    now,
  });
  if (decision.kind !== "nudge") return;

  state.lastNudge.set(parentSessionId, now);

  // Bound the debounce map so a long-running bridge with many
  // coordinators doesn't accumulate entries forever.
  if (state.lastNudge.size > 256) {
    const cutoff = now - NUDGE_DEBOUNCE_MS * 4;
    for (const [k, t] of state.lastNudge) {
      if (t < cutoff) state.lastNudge.delete(k);
    }
  }

  try {
    resumeSessionWithLifecycle({
      cwd: BRIDGE_ROOT,
      sessionId: parentSessionId,
      message: buildNudgeMessage({ taskId, children: decision.children }),
      // Coordinator runs unattended — same bypass mode the original
      // spawn / continue paths use.
      settings: { mode: "bypassPermissions" },
      context: `coordinator-nudge ${taskId}`,
    });
    logInfo(
      "coordinator-nudge",
      `nudged coordinator after ${decision.children.length} child(ren) settled`,
      {
        taskId,
        coordinator: parentSessionId.slice(0, 8),
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
  if (!isChildTerminalTransition(ev)) return;
  const parentId = ev.run.parentSessionId;
  if (!parentId) return;
  const taskId = ev.taskId;
  // Defer briefly so any synchronous retry-spawn fired from the same
  // lifecycle exit handler can land its `queued` row first. Without
  // this, a `failed` → retry path would race: we'd see "all terminal"
  // because the retry's appendRun hadn't completed yet, then nudge,
  // then the retry would actually start running — coordinator gets
  // pinged for nothing.
  const t = setTimeout(() => {
    void evaluateAndNudge(taskId, parentId);
  }, EVAL_DELAY_MS);
  if (typeof t === "object" && t !== null && "unref" in t) {
    (t as { unref: () => void }).unref();
  }
}

/**
 * Idempotent installer. Wired from `instrumentation.ts` at server boot
 * (and re-run on Next.js HMR — the `installed` flag stashed on
 * globalThis prevents double-subscription).
 */
export function ensureCoordinatorNudge(): void {
  if (state.installed) return;
  state.installed = true;
  state.unsubscribe = subscribeMetaAll(onMetaChange);
  logInfo("coordinator-nudge", "installed");
}

/**
 * Test helper — tear down the subscription and clear the debounce map
 * so each test starts from a clean slate.
 */
export function _resetCoordinatorNudgeForTest(): void {
  if (state.unsubscribe) {
    try { state.unsubscribe(); } catch { /* ignore */ }
  }
  state.installed = false;
  state.unsubscribe = null;
  state.lastNudge.clear();
}
