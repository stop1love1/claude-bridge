import { EventEmitter } from "node:events";

/**
 * Per-session pub/sub for events the chat UI cares about but that
 * don't live in the .jsonl tail:
 *   - partial: assistant text deltas streamed by `claude --output-format
 *     stream-json --include-partial-messages`. We forward each delta
 *     so the SSE client can render Claude's reply token-by-token,
 *     instead of waiting for the canonical .jsonl line that only lands
 *     when the turn is complete.
 *   - alive:  set true when a child claude process registers for this
 *     session, false when it exits. Used by the Stop button to remain
 *     visible across long tool calls / "thinking" gaps that the
 *     previous lastTs heuristic couldn't cover.
 *
 * Stashed on globalThis so Next.js dev HMR doesn't drop subscribers
 * across module reloads — same trick as `spawnRegistry` and the tail
 * replay buffer.
 */
export interface PartialEvent {
  /** Assistant message id from the API (msg_…), so the client can
   *  group deltas across content blocks within the same turn. */
  messageId: string;
  /** Content block index. Claude can stream multiple blocks (text +
   *  tool_use) within one message; we currently only forward text. */
  index: number;
  /** Delta text fragment as emitted by stream_event/content_block_delta. */
  text: string;
}

/**
 * Activity indicator the UI shows above the composer — mirrors what
 * the Claude Code CLI puts at the bottom of its terminal screen
 * ("Thinking…", "Running: <bash>", etc.). Sourced from claude's
 * `system/status`, `system/task_started`, and `system/task_notification`
 * stream-json events.
 *
 *   thinking → API call is in flight; no tool running yet
 *   running  → a tool / Bash / sub-task is executing; `label` is the
 *              human-readable description claude attached to the task
 *   idle     → message_stop fired or the child exited
 */
export interface StatusEvent {
  kind: "thinking" | "running" | "idle";
  label?: string;
}

interface SessionEventsRegistry {
  emitters: Map<string, EventEmitter>;
  /** Coarse alive flag mirrored here so a freshly-connected SSE client
   *  can answer "is something running right now?" without racing the
   *  next start/end emit. */
  alive: Map<string, boolean>;
}

const G = globalThis as unknown as { __bridgeSessionEvents?: SessionEventsRegistry };
const registry: SessionEventsRegistry = G.__bridgeSessionEvents ?? {
  emitters: new Map(),
  alive: new Map(),
};
G.__bridgeSessionEvents = registry;

function getEmitter(sessionId: string): EventEmitter {
  let e = registry.emitters.get(sessionId);
  if (!e) {
    e = new EventEmitter();
    // Each open SSE connection adds one listener trio; default cap (10)
    // would warn for the second tab on the same session. 100 is plenty.
    e.setMaxListeners(100);
    registry.emitters.set(sessionId, e);
  }
  return e;
}

export function emitPartial(sessionId: string, p: PartialEvent): void {
  getEmitter(sessionId).emit("partial", p);
}

export function emitAlive(sessionId: string, alive: boolean): void {
  registry.alive.set(sessionId, alive);
  getEmitter(sessionId).emit("alive", alive);
  // Once a child has exited, the emitter and the alive flag are no
  // longer load-bearing — but a tail SSE connection may still be
  // subscribed for a few seconds while the UI shows the final state.
  // Defer eviction so subscribers can drain, then drop the entries to
  // keep the global Map bounded over a long-lived bridge.
  if (!alive) scheduleEvict(sessionId);
}

const EVICT_DELAY_MS = 60_000;
const evictTimers = new Map<string, ReturnType<typeof setTimeout>>();
function scheduleEvict(sessionId: string): void {
  const existing = evictTimers.get(sessionId);
  if (existing) clearTimeout(existing);
  const t = setTimeout(() => {
    evictTimers.delete(sessionId);
    const e = registry.emitters.get(sessionId);
    if (e && e.listenerCount("partial") + e.listenerCount("alive") + e.listenerCount("status") > 0) {
      // A late subscriber re-attached during the delay (e.g. user
      // reopened the tab). Reschedule rather than evict.
      scheduleEvict(sessionId);
      return;
    }
    registry.emitters.delete(sessionId);
    registry.alive.delete(sessionId);
  }, EVICT_DELAY_MS);
  // Allow Node to exit even if these timers are still pending.
  if (typeof t === "object" && t !== null && "unref" in t) {
    (t as { unref: () => void }).unref();
  }
  evictTimers.set(sessionId, t);
}

export function emitStatus(sessionId: string, s: StatusEvent): void {
  getEmitter(sessionId).emit("status", s);
}

export function isAlive(sessionId: string): boolean {
  return registry.alive.get(sessionId) ?? false;
}

export interface SessionSubscriptionHandlers {
  onPartial?: (p: PartialEvent) => void;
  onAlive?: (alive: boolean) => void;
  onStatus?: (s: StatusEvent) => void;
}

export function subscribeSession(
  sessionId: string,
  handlers: SessionSubscriptionHandlers,
): () => void {
  const e = getEmitter(sessionId);
  if (handlers.onPartial) e.on("partial", handlers.onPartial);
  if (handlers.onAlive) e.on("alive", handlers.onAlive);
  if (handlers.onStatus) e.on("status", handlers.onStatus);
  return () => {
    if (handlers.onPartial) e.off("partial", handlers.onPartial);
    if (handlers.onAlive) e.off("alive", handlers.onAlive);
    if (handlers.onStatus) e.off("status", handlers.onStatus);
  };
}
