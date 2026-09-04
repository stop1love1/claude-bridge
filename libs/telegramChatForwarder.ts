import { subscribeMetaAll, type MetaChangeEvent, type Run } from "./meta";
import { subscribeSession, type PartialEvent } from "./sessionEvents";
import { getManifestTelegramSettings } from "./apps";
import { sendTelegramRaw } from "./telegramNotifier";
import { logWarn } from "./log";

interface SessionBuffer {
  sessionId: string;
  role: string;
  repo: string;
  taskId: string;
  messageId: string | null;
  text: string;
  unsubscribe: () => void;
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

function escapeMarkdownV2(s: string): string {
  return s.replace(/([_*[\]()~`>#+\-=|{}.!\\])/g, "\\$1");
}

function isInScope(
  role: string,
  policy: "off" | "coordinator-only" | "all",
): boolean {
  if (policy === "off") return false;
  if (role === "style-critic" || role === "semantic-verifier") return false;
  if (role === "coordinator") return false;
  if (policy === "coordinator-only") return false;
  return true;
}

function renderHeader(buf: SessionBuffer): string {
  const role = escapeMarkdownV2(buf.role);
  const repo = escapeMarkdownV2(buf.repo);
  const taskId = escapeMarkdownV2(buf.taskId);
  return `💬 *${role}* @ \`${repo}\` · task \`${taskId}\``;
}

const importantRegexCache = new Map<string, RegExp>();
const IMPORTANT_REGEX_CACHE_MAX = 50;
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function importantPatternFor(tokens: string[]): RegExp | null {
  if (tokens.length === 0) return null;
  const key = tokens.join("");
  let cached = importantRegexCache.get(key);
  if (!cached) {
    if (importantRegexCache.size >= IMPORTANT_REGEX_CACHE_MAX) {
      importantRegexCache.clear();
    }
    cached = new RegExp(tokens.map(escapeRegex).join("|"), "i");
    importantRegexCache.set(key, cached);
  }
  return cached;
}

function flushBuffer(buf: SessionBuffer, reason: "rotate" | "exit"): void {
  const trimmed = buf.text.trim();
  buf.text = "";
  if (!trimmed) return;
  const settings = getManifestTelegramSettings();
  if (settings.forwardChat === "off") return;
  if (trimmed.length < settings.forwardChatMinChars) return;
  if (settings.forwardChatFilter === "important-only") {
    const re = importantPatternFor(settings.forwardChatImportantPatterns);
    if (!re || !re.test(trimmed)) return;
  }

  const header = renderHeader(buf);
  const body = escapeMarkdownV2(trimmed);
  const text = `${header}\n${body}`;
  void sendTelegramRaw(text).catch((err) => {
    logWarn(
      "telegram-chat",
      `flush failed for ${buf.sessionId} (${reason})`,
      { error: (err as Error).message },
    );
  });
}

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
  }
  state.buffers.delete(sessionId);
}

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
      if (buf.messageId === null) {
        buf.messageId = p.messageId;
      }
      if (p.messageId !== buf.messageId) {
        flushBuffer(buf, "rotate");
        buf.messageId = p.messageId;
      }
      buf.text += p.text;
    },
    onAlive: (alive: boolean) => {
      if (alive) return;
      if (!buf.closed) flushBuffer(buf, "exit");
    },
  });

  state.buffers.set(sessionId, buf);
}

function onMetaChange(ev: MetaChangeEvent): void {
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
  if (
    run.status === "done" ||
    run.status === "failed" ||
    run.status === "cancelled" ||
    run.status === "stale"
  ) {
    closeBuffer(run.sessionId, "exit");
  }
}

export function ensureTelegramChatForwarder(): void {
  if (state.installed) return;
  state.installed = true;
  state.unsubscribeMeta = subscribeMetaAll(onMetaChange);
}

export function teardownTelegramChatForwarder(): void {
  if (state.unsubscribeMeta) {
    try { state.unsubscribeMeta(); } catch { }
    state.unsubscribeMeta = null;
  }
  for (const sid of Array.from(state.buffers.keys())) {
    closeBuffer(sid, "exit");
  }
  state.installed = false;
}
