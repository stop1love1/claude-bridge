/**
 * Per-sessionId FIFO message queue.
 *
 * Why: when the user types a second message while a turn is still
 * running, the old behavior was to immediately spawn another
 * `claude --resume` for the same sessionId. Two `--resume` processes
 * sharing one .jsonl truncate each other's output (the in-flight
 * turn ends with a `stop_sequence` cut-off and the second turn takes
 * over) — exactly the regression the operator hit.
 *
 * Fix: when the message route detects `isAlive(sessionId)` it pushes
 * the payload here instead of spawning. When the running process
 * exits, the route's own exit hook (attached at spawn time) drains
 * one queued message and re-enters the spawn path. Repeat until
 * empty.
 *
 * Stop semantics: an explicit `killSession` clears the queue too —
 * "Stop" reads as "abort everything I had pending", not "abort the
 * current step but keep marching through what I queued behind it".
 *
 * Storage: in-memory, HMR-safe via globalThis stash (matches
 * spawnRegistry). Lost on full server restart — acceptable because
 * a restart already breaks every in-flight session anyway.
 */
import type { ChatSettings } from "./spawn";

export interface QueuedMessage {
  message: string;
  cwd: string;
  settings: ChatSettings;
  settingsPath: string;
  context?: string;
  enqueuedAt: number;
}

interface QueueState {
  // Map preserves insertion order, but we use arrays so we can shift()
  // and read length cheaply.
  byId: Map<string, QueuedMessage[]>;
}

const G = globalThis as unknown as { __bridgeMessageQueue?: QueueState };
const state: QueueState = G.__bridgeMessageQueue ?? { byId: new Map() };
G.__bridgeMessageQueue = state;

/**
 * Append `msg` to the FIFO for `sessionId`. Returns the new queue
 * length AFTER this push (so callers can surface "you're position N
 * in the queue" to the user).
 */
export function enqueueMessage(sessionId: string, msg: QueuedMessage): number {
  let list = state.byId.get(sessionId);
  if (!list) {
    list = [];
    state.byId.set(sessionId, list);
  }
  list.push(msg);
  return list.length;
}

/**
 * Pop the oldest queued message for `sessionId`. Returns `null` when
 * the queue is empty (or never existed). Cleans up the map entry on
 * the last drain so empty queues don't accumulate.
 */
export function dequeueMessage(sessionId: string): QueuedMessage | null {
  const list = state.byId.get(sessionId);
  if (!list || list.length === 0) return null;
  const next = list.shift()!;
  if (list.length === 0) state.byId.delete(sessionId);
  return next;
}

/** Number of messages waiting. 0 when no queue / empty queue. */
export function queueLength(sessionId: string): number {
  return state.byId.get(sessionId)?.length ?? 0;
}

/**
 * Drop everything queued for `sessionId`. Returns how many entries
 * were discarded — useful for telemetry / "cleared N pending" toasts.
 */
export function clearQueue(sessionId: string): number {
  const len = state.byId.get(sessionId)?.length ?? 0;
  state.byId.delete(sessionId);
  return len;
}

/** Test-only: nuke every queue. */
export function _resetAllQueuesForTest(): void {
  state.byId.clear();
}
