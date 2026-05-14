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
import { existsSync, readFileSync } from "node:fs";
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
/**
 * Cap how many times we'll re-nudge a coordinator that keeps exiting
 * without writing summary.md. Without a cap, a model that genuinely
 * can't write the file (e.g. context limit, persistent error) would
 * loop forever every time the user's wake handler ticks. After this
 * many failed nudges we let the coordinator's `running → done` flip
 * land so the row stops looking stuck — the operator can re-dispatch
 * by hand from the UI.
 */
const SUMMARY_NUDGE_MAX_ATTEMPTS = 3;

/**
 * Returns true iff `sessions/<taskId>/summary.md` is missing, empty,
 * or contains only whitespace. The coordinator is contracted to write
 * a final report into that file before exiting cleanly (see
 * `prompts/coordinator-playbook.md` §5); when it's absent we treat the
 * exit as "premature" and let the nudge path resume the session so the
 * model gets a second chance to write the summary instead of the row
 * silently flipping to `done` with no user-visible output.
 */
export function isSummaryMissing(taskId: string): boolean {
  const path = join(SESSIONS_DIR, taskId, "summary.md");
  if (!existsSync(path)) return true;
  try {
    return readFileSync(path, "utf8").trim().length === 0;
  } catch {
    // Read errors (permission, transient FS hiccup) — be conservative
    // and treat as missing so we don't silently swallow the case where
    // the file genuinely failed to write.
    return true;
  }
}

interface NudgeState {
  installed: boolean;
  unsubscribe: (() => void) | null;
  /** coordinator sessionId → epoch-ms of the last nudge we sent. */
  lastNudge: Map<string, number>;
  /**
   * coordinator sessionId → count of consecutive nudges that fired
   * because `summary.md` was missing. Reset to 0 once a nudge lands on
   * a coordinator that DID write the summary; bounded by
   * `SUMMARY_NUDGE_MAX_ATTEMPTS` so a model that genuinely can't
   * comply doesn't get hammered forever.
   */
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
  /**
   * Whether `summary.md` is currently missing/empty for this task.
   * Optional for back-compat with existing callers; defaults to `true`
   * (the legacy "always nudge once conditions are met" behavior). When
   * the caller knows the file is present, pass `false` to skip the
   * resume — re-nudging a coordinator that already shipped its summary
   * just burns tokens producing noise the operator will discard.
   */
  summaryMissing?: boolean;
  /**
   * How many times we've already nudged THIS coordinator specifically
   * because of a missing summary. Caps the resume loop so a model that
   * genuinely can't write the file doesn't get hammered forever.
   * Optional / defaults to 0.
   */
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

  // Default behavior preserved for tests + callers that don't yet
  // thread the summary state through — treat absence as "missing"
  // because the legacy nudge always fired when the rest of the gates
  // passed. Callers (notably `evaluateAndNudge` below) read the file
  // and pass the real value.
  const summaryMissing = args.summaryMissing ?? true;
  if (!summaryMissing) {
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

async function evaluateAndNudge(
  taskId: string,
  parentSessionId: string,
  trigger = "child-exit",
): Promise<void> {
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
  const summaryMissing = isSummaryMissing(taskId);
  const decision = decideNudge({
    parentSessionId,
    runs: metaAfter.runs,
    isAlive,
    lastNudgeAt: state.lastNudge.get(parentSessionId) ?? null,
    now,
    summaryMissing,
    summaryNudgeAttempts: state.summaryNudgeAttempts.get(parentSessionId) ?? 0,
  });
  if (decision.kind !== "nudge") {
    // Coordinator finished cleanly with summary on disk — clear any
    // counted attempts so a future task with the same coordinator
    // sessionId (won't happen in practice, but the map is keyed by
    // sessionId so it's safe to be tidy) starts fresh.
    if (!summaryMissing) state.summaryNudgeAttempts.delete(parentSessionId);
    return;
  }

  state.lastNudge.set(parentSessionId, now);
  state.summaryNudgeAttempts.set(
    parentSessionId,
    (state.summaryNudgeAttempts.get(parentSessionId) ?? 0) + 1,
  );

  // Bound the debounce map so a long-running bridge with many
  // coordinators doesn't accumulate entries forever.
  if (state.lastNudge.size > 256) {
    const cutoff = now - NUDGE_DEBOUNCE_MS * 4;
    for (const [k, t] of state.lastNudge) {
      if (t < cutoff) state.lastNudge.delete(k);
    }
  }
  if (state.summaryNudgeAttempts.size > 256) {
    // No timestamp on this counter — just drop the bottom half of
    // entries when we're over cap. Eviction order doesn't matter:
    // the counter is consulted on the next nudge and missing entries
    // default to 0.
    const keys = Array.from(state.summaryNudgeAttempts.keys());
    for (const k of keys.slice(0, keys.length / 2)) {
      state.summaryNudgeAttempts.delete(k);
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
  // Two trigger sources:
  //   (a) a child of THIS coordinator just hit a terminal state
  //   (b) the coordinator itself just exited (transition to done/failed/stale)
  //
  // Without (b), a coordinator that exits AFTER every child has already
  // settled would never get another transition to react to — no child
  // would fire again, and the coordinator's own exit is filtered out of
  // the child-terminal predicate. Fix: also schedule an evaluation when
  // the coordinator's own row transitions to a terminal state. The
  // evaluation logic itself (`evaluateAndNudge`) re-reads meta and
  // makes the right call (resume vs. skip) based on summary.md
  // presence + nudge-attempt budget.
  if (ev.kind !== "transition" || !ev.run || !ev.sessionId) return;
  if (!isTerminal(ev.run.status)) return;

  let parentId: string | null = null;
  let label: string;
  if (ev.run.role === "coordinator") {
    // Self-exit trigger — the coordinator IS the parent for this eval.
    parentId = ev.sessionId;
    label = "self-exit";
  } else if (ev.run.parentSessionId) {
    parentId = ev.run.parentSessionId;
    label = "child-exit";
  } else {
    return;
  }

  const taskId = ev.taskId;
  // Defer briefly so any synchronous retry-spawn fired from the same
  // lifecycle exit handler can land its `queued` row first. Without
  // this, a `failed` → retry path would race: we'd see "all terminal"
  // because the retry's appendRun hadn't completed yet, then nudge,
  // then the retry would actually start running — coordinator gets
  // pinged for nothing.
  const t = setTimeout(() => {
    void evaluateAndNudge(taskId, parentId, label);
  }, EVAL_DELAY_MS);
  if (typeof t === "object" && t !== null && "unref" in t) {
    (t as { unref: () => void }).unref();
  }
}

/**
 * Public entry point for callers OUTSIDE the meta-event stream that
 * want to re-evaluate a coordinator. Same shape as the internal
 * scheduling — `EVAL_DELAY_MS` deferral preserved so an in-flight
 * retry/spawn can land its row first.
 *
 * Used by `runLifecycle.succeedRun` to guarantee a nudge fires when
 * the coordinator's own process exits, even in the edge case where no
 * child transition will follow (all children already settled before
 * the coordinator exited).
 */
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
  state.summaryNudgeAttempts.clear();
}
