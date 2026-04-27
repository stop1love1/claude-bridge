/**
 * Telegram chat forwarder — server-only.
 *
 * Mirrors the assistant's prose from spawned Claude sessions to Telegram
 * so the operator can follow long-running coordinator runs from their
 * phone without having to load the bridge UI. Disabled by default — the
 * volume can get noisy fast — and gated by `bridge.json.telegram.forwardChat`:
 *
 *   "off"               — never forward (default).
 *   "coordinator-only"  — forward `role: "coordinator"` runs only.
 *   "all"               — forward every spawned run.
 *
 * Implementation shape:
 *
 *   1. Subscribe globally to `subscribeMetaAll` so we see every `spawned`
 *      and `transition` event the bridge emits.
 *   2. On `spawned` (a new run was just appended) whose role matches the
 *      forwarding policy, attach a per-session `subscribeSession` handler
 *      that buffers `partial` text deltas grouped by `messageId`.
 *   3. When the buffered messageId changes (the model started a new
 *      assistant turn) OR `alive` flips false (the child exited), flush
 *      the buffered text to Telegram with a header showing role / repo /
 *      taskId. Skip flushes shorter than `forwardChatMinChars` to keep
 *      "OK." / "Done." chatter out.
 *   4. On the run's lifecycle `transition` to a terminal status, tear
 *      down the subscription so we don't leak listeners.
 *
 * Safety: the forwarder NEVER throws upstream — every send error is
 * logged and swallowed. A misbehaving Telegram channel must not stall
 * the meta event emitter or the SSE stream.
 */
import { subscribeMetaAll, type MetaChangeEvent, type Run } from "./meta";
import { subscribeSession, type PartialEvent } from "./sessionEvents";
import { getManifestTelegramSettings } from "./apps";
import { sendTelegramRaw } from "./telegramNotifier";

interface SessionBuffer {
  /** sessionId of the spawned run we're following. */
  sessionId: string;
  /** Coordinator-assigned label, e.g. "coordinator", "coder". */
  role: string;
  /** Registered app name (or bridge folder name for coordinator). */
  repo: string;
  /** Task id, e.g. `t_20260427_001` — surfaced in the Telegram header. */
  taskId: string;
  /** Active assistant message id; null until the first `partial` lands. */
  messageId: string | null;
  /** Accumulated text deltas for `messageId`; flushed on rotate / exit. */
  text: string;
  /** Cleanup callback to detach the per-session subscription. */
  unsubscribe: () => void;
  /** True once we've started flushing — used to gate redundant teardown. */
  closed: boolean;
}

interface ForwarderState {
  installed: boolean;
  unsubscribeMeta: (() => void) | null;
  buffers: Map<string, SessionBuffer>;
}

const G = globalThis as unknown as {
  __bridgeTelegramChatForwarder?: ForwarderState;
};
const state: ForwarderState =
  G.__bridgeTelegramChatForwarder ?? {
    installed: false,
    unsubscribeMeta: null,
    buffers: new Map(),
  };
G.__bridgeTelegramChatForwarder = state;

/**
 * Telegram MarkdownV2 reserves these chars; escape them so role names
 * with `_` / `-` / `.` (and the surrounding header punctuation) don't
 * break the message render.
 */
function escapeMarkdownV2(s: string): string {
  return s.replace(/([_*[\]()~`>#+\-=|{}.!\\])/g, "\\$1");
}

/**
 * Decide whether the role / repo combo is in scope for forwarding given
 * the current policy. Coordinator-only is the recommended default; "all"
 * fires for every spawned child. Quality-gate spawns (style-critic,
 * semantic-verifier) are filtered out under both policies because they're
 * rule-based judges, not human-readable narration.
 */
function isInScope(
  role: string,
  policy: "off" | "coordinator-only" | "all",
): boolean {
  if (policy === "off") return false;
  // Quality gate spawns are noisy verdict-only LLMs; never forward.
  if (role === "style-critic" || role === "semantic-verifier") return false;
  if (policy === "coordinator-only") return role === "coordinator";
  return true;
}

/**
 * Render the chat-forward header. Distinct icon from the lifecycle
 * notifier (✅/⚠/🔐) so the operator can scan their Telegram feed and
 * tell forwarded chat from status updates at a glance.
 */
function renderHeader(buf: SessionBuffer): string {
  const role = escapeMarkdownV2(buf.role);
  const repo = escapeMarkdownV2(buf.repo);
  const taskId = escapeMarkdownV2(buf.taskId);
  return `💬 *${role}* @ \`${repo}\` · task \`${taskId}\``;
}

/**
 * Flush whatever's currently buffered for this session as a single
 * Telegram message. No-op when the buffer is empty or below the
 * configured minimum length. Resets the buffer after flushing.
 */
function flushBuffer(buf: SessionBuffer, reason: "rotate" | "exit"): void {
  const trimmed = buf.text.trim();
  buf.text = "";
  if (!trimmed) return;
  const settings = getManifestTelegramSettings();
  if (settings.forwardChat === "off") return;
  if (trimmed.length < settings.forwardChatMinChars) return;

  const header = renderHeader(buf);
  const body = escapeMarkdownV2(trimmed);
  const text = `${header}\n${body}`;
  void sendTelegramRaw(text).catch((err) => {
    // sendTelegramRaw already swallows per-channel errors; this catch
    // is belt-and-suspenders for any unhandled rejection.
    console.warn(
      `[telegram-chat] flush failed for ${buf.sessionId} (${reason}):`,
      (err as Error).message,
    );
  });
}

/**
 * Tear down a per-session subscription. Called when the run flips to a
 * terminal status or when the forwarder itself is torn down.
 */
function closeBuffer(sessionId: string, reason: "rotate" | "exit"): void {
  const buf = state.buffers.get(sessionId);
  if (!buf) return;
  if (buf.closed) {
    state.buffers.delete(sessionId);
    return;
  }
  buf.closed = true;
  flushBuffer(buf, reason);
  try {
    buf.unsubscribe();
  } catch {
    /* ignore */
  }
  state.buffers.delete(sessionId);
}

/**
 * Attach a `subscribeSession` handler for the freshly-spawned run.
 * Buffers `partial.text` deltas grouped by `messageId`; flushes on
 * messageId rotation or when `alive` flips false (the child exited).
 */
function attachToSession(args: {
  sessionId: string;
  role: string;
  repo: string;
  taskId: string;
}): void {
  const { sessionId, role, repo, taskId } = args;
  if (state.buffers.has(sessionId)) return;

  const buf: SessionBuffer = {
    sessionId,
    role,
    repo,
    taskId,
    messageId: null,
    text: "",
    unsubscribe: () => {},
    closed: false,
  };

  buf.unsubscribe = subscribeSession(sessionId, {
    onPartial: (p: PartialEvent) => {
      if (buf.closed) return;
      // First delta of the run — adopt this messageId as the active one.
      if (buf.messageId === null) {
        buf.messageId = p.messageId;
      }
      // New assistant turn started — flush whatever was being built and
      // start a fresh buffer under the new messageId.
      if (p.messageId !== buf.messageId) {
        flushBuffer(buf, "rotate");
        buf.messageId = p.messageId;
      }
      buf.text += p.text;
    },
    onAlive: (alive: boolean) => {
      if (alive) return;
      // Process exited — flush the tail buffer. The teardown on
      // `transition` (below) handles unsubscribe; we just drain text
      // here so a session that exits before any meta transition fires
      // (rare) doesn't lose its final message.
      if (!buf.closed) flushBuffer(buf, "exit");
    },
  });

  state.buffers.set(sessionId, buf);
}

/**
 * Meta event router. Drives both the spawn-side attach and the
 * exit-side detach; the forwarder is otherwise stateless across
 * meta events.
 */
function onMetaChange(ev: MetaChangeEvent): void {
  // We only care about the spawn / lifecycle mutations of individual
  // runs — task-section moves and full writeMeta events don't carry the
  // run we'd need to attach to.
  if (ev.kind === "spawned" && ev.run) {
    handleSpawned(ev.taskId, ev.run);
    return;
  }
  if (ev.kind === "transition" && ev.run) {
    handleTransition(ev.run);
    return;
  }
}

function handleSpawned(taskId: string, run: Run): void {
  const settings = getManifestTelegramSettings();
  if (settings.forwardChat === "off") return;
  if (!isInScope(run.role, settings.forwardChat)) return;
  attachToSession({
    sessionId: run.sessionId,
    role: run.role,
    repo: run.repo,
    taskId,
  });
}

function handleTransition(run: Run): void {
  // Any terminal status drains the buffer and detaches. We tear down on
  // both done AND failed so a crashed coordinator still gets its tail
  // text forwarded (sometimes the most useful signal).
  if (run.status === "done" || run.status === "failed" || run.status === "stale") {
    closeBuffer(run.sessionId, "exit");
  }
}

/**
 * Idempotently install the chat forwarder. Called from
 * `ensureTelegramNotifier` after the lifecycle notifier itself is up.
 * Does NOT check whether forwarding is currently enabled — the policy
 * is read on every event so toggling it via the settings UI takes
 * effect immediately without a teardown / reinstall cycle.
 */
export function ensureTelegramChatForwarder(): void {
  if (state.installed) return;
  state.installed = true;
  state.unsubscribeMeta = subscribeMetaAll(onMetaChange);
}

/**
 * Reverse of `ensureTelegramChatForwarder`. Drains every active
 * per-session buffer (so a teardown mid-run still surfaces what was
 * accumulated) and detaches the meta subscription.
 */
export function teardownTelegramChatForwarder(): void {
  if (state.unsubscribeMeta) {
    try { state.unsubscribeMeta(); } catch { /* ignore */ }
    state.unsubscribeMeta = null;
  }
  for (const sid of Array.from(state.buffers.keys())) {
    closeBuffer(sid, "exit");
  }
  state.installed = false;
}
