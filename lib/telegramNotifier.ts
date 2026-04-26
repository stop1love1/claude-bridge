/**
 * Telegram notifier — server-only.
 *
 * Subscribes to the bridge's per-task lifecycle events and the global
 * permission-pending stream, and forwards a short Markdown message to
 * a configured Telegram chat. Disabled (no network calls) unless both
 * `botToken` and `chatId` are set — read primarily from
 * `bridge.json.telegram` (operator-managed via the bridge UI), with a
 * fallback to the legacy `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID`
 * env vars so existing installs keep working until they migrate.
 *
 * The notifier installs once per process (HMR-safe) and never throws —
 * any send error is logged to the bridge's console with a brief reason.
 *
 * Event matrix:
 *   - run transition → done    → ✅ "<role> @ <repo> done"
 *   - run transition → failed  → ⚠ "<role> @ <repo> failed"
 *   - permission pending       → 🔐 "<role>/<sid> wants <tool>"
 *
 * Quiet by default to avoid spam: `transition` events for `running` /
 * `queued` are ignored, and a per-event coalescer drops duplicates that
 * fire within `DEDUPE_MS` of each other.
 */
import { subscribeMetaAll, type MetaChangeEvent } from "./meta";
import { subscribeAllPermissions, type PendingRequest } from "./permissionStore";
import { getManifestTelegramSettings } from "./apps";

const TG_HOST = "https://api.telegram.org";
const DEDUPE_MS = 1500;
const MAX_TEXT = 3500;

interface NotifierState {
  installed: boolean;
  unsubscribers: Array<() => void>;
  recent: Map<string, number>;
}

const G = globalThis as unknown as { __bridgeTelegramNotifier?: NotifierState };
const state: NotifierState =
  G.__bridgeTelegramNotifier ?? {
    installed: false,
    unsubscribers: [],
    recent: new Map(),
  };
G.__bridgeTelegramNotifier = state;

/**
 * Resolve the active Telegram credentials. Prefers `bridge.json.telegram`
 * (operator-managed via the bridge UI); falls back to legacy env vars
 * for installs that haven't migrated yet. Returns `null` when neither
 * source has both fields filled.
 */
function envConfig(): { token: string; chatId: string } | null {
  const settings = getManifestTelegramSettings();
  if (settings.botToken && settings.chatId) {
    return { token: settings.botToken, chatId: settings.chatId };
  }
  return null;
}

function escapeMarkdownV2(s: string): string {
  // Telegram MarkdownV2 reserves these chars; escape them so role/repo
  // names with `_` / `.` / `-` don't break the message render.
  return s.replace(/([_*[\]()~`>#+\-=|{}.!\\])/g, "\\$1");
}

async function sendTelegram(text: string): Promise<void> {
  const cfg = envConfig();
  if (!cfg) return;
  const truncated = text.length > MAX_TEXT ? text.slice(0, MAX_TEXT) + "…" : text;
  const url = `${TG_HOST}/bot${encodeURIComponent(cfg.token)}/sendMessage`;
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: cfg.chatId,
        text: truncated,
        parse_mode: "MarkdownV2",
        disable_web_page_preview: true,
      }),
      // 10s upper bound: Telegram is fast in the happy path; we don't
      // want a slow connection to wedge the event loop.
      signal: AbortSignal.timeout(10_000),
    });
    if (!r.ok) {
      const body = await r.text().catch(() => "");
      console.warn(`[telegram] send failed: ${r.status} ${body.slice(0, 200)}`);
    }
  } catch (err) {
    console.warn(`[telegram] send error: ${(err as Error).message}`);
  }
}

function shouldSend(key: string): boolean {
  const now = Date.now();
  const last = state.recent.get(key) ?? 0;
  if (now - last < DEDUPE_MS) return false;
  state.recent.set(key, now);
  // Cap the dedupe map; old entries can't fire dupes anyway.
  if (state.recent.size > 256) {
    const cutoff = now - DEDUPE_MS * 4;
    for (const [k, t] of state.recent) {
      if (t < cutoff) state.recent.delete(k);
    }
  }
  return true;
}

function onMetaChange(ev: MetaChangeEvent): void {
  if (ev.kind !== "transition" || !ev.run) return;
  const next = ev.run.status;
  if (next !== "done" && next !== "failed") return;
  const dedupeKey = `meta:${ev.taskId}:${ev.sessionId}:${next}`;
  if (!shouldSend(dedupeKey)) return;
  const role = escapeMarkdownV2(ev.run.role);
  const repo = escapeMarkdownV2(ev.run.repo);
  const taskId = escapeMarkdownV2(ev.taskId);
  const icon = next === "done" ? "✅" : "⚠️";
  const verb = next === "done" ? "completed" : "failed";
  const text =
    `${icon} *${role}* ${verb}\n` +
    `task \`${taskId}\` · repo \`${repo}\``;
  void sendTelegram(text);
}

function onPermission(req: PendingRequest): void {
  const dedupeKey = `perm:${req.sessionId}:${req.requestId}`;
  if (!shouldSend(dedupeKey)) return;
  const tool = escapeMarkdownV2(req.tool);
  const sid = escapeMarkdownV2(req.sessionId.slice(0, 8));
  const text =
    `🔐 *Permission needed*\n` +
    `tool \`${tool}\` · session \`${sid}\``;
  void sendTelegram(text);
}

export function ensureTelegramNotifier(): void {
  if (state.installed) return;
  if (!envConfig()) return;
  state.installed = true;
  state.unsubscribers.push(subscribeMetaAll(onMetaChange));
  state.unsubscribers.push(subscribeAllPermissions(onPermission));
  // eslint-disable-next-line no-console
  console.info("[telegram] notifier installed");
}

export function teardownTelegramNotifier(): void {
  for (const fn of state.unsubscribers.splice(0)) {
    try { fn(); } catch { /* ignore */ }
  }
  state.installed = false;
}

/**
 * Pull the human-readable `description` field out of a Telegram error
 * response (`{"ok":false,"error_code":403,"description":"Forbidden: …"}`),
 * falling back to the raw body when the response wasn't JSON. Caps the
 * result so a runaway error message can't blow out a toast.
 */
function extractTelegramError(body: string): string {
  if (!body) return "(empty body)";
  try {
    const parsed = JSON.parse(body) as { description?: unknown };
    if (typeof parsed.description === "string" && parsed.description.trim()) {
      return parsed.description.trim().slice(0, 200);
    }
  } catch {
    /* not JSON — fall through to raw */
  }
  return body.slice(0, 200);
}

/**
 * Surface the configured/health state to a `/api/telegram/test` route so
 * the user can verify their bot token + chat id without grepping logs.
 */
export async function pingTelegramTest(): Promise<{ ok: boolean; reason?: string }> {
  const cfg = envConfig();
  if (!cfg) {
    return {
      ok: false,
      reason: "telegram.botToken / telegram.chatId not set in bridge.json (and no env fallback)",
    };
  }
  try {
    const r = await fetch(`${TG_HOST}/bot${encodeURIComponent(cfg.token)}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: cfg.chatId,
        text: "✅ Claude Bridge → Telegram test OK",
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!r.ok) {
      const body = await r.text().catch(() => "");
      return { ok: false, reason: `${r.status} ${extractTelegramError(body)}` };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: (err as Error).message };
  }
}
