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
 * What fires is gated by `notificationLevel` (see `libs/apps`):
 *   - "minimal" — coordinator done/failed, ANY child failure, section
 *                 → BLOCKED / DONE, permission requests (per-tool
 *                 coalesced).
 *   - "normal"  — minimal + child completions + section → DOING (on
 *                 START only, not "Resumed").
 *   - "verbose" — every transition / section move / permission, with
 *                 only the legacy 1.5s requestId dedupe.
 *
 * Per-event short-window dedupe (`DEDUPE_MS`) still runs at every level
 * so a flood of identical events from a flapping session can't bypass
 * the volume control.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { subscribeMetaAll, type MetaChangeEvent } from "./meta";
import { subscribeAllPermissions, type PendingRequest } from "./permissionStore";
import {
  getManifestTelegramSettings,
  type TelegramNotificationLevel,
} from "./apps";
import { getPublicBridgeUrl, SESSIONS_DIR } from "./paths";
import { SECTION_BLOCKED, SECTION_DOING, SECTION_DONE, SECTION_TODO } from "./tasks";
import {
  startTelegramCommandPoller,
  startTelegramUserCommandListener,
  stopTelegramCommandPoller,
  stopTelegramUserCommandListener,
} from "./telegramCommands";
import {
  isUserClientConfigured,
  sendUserMessage,
} from "./telegramUserClient";
import {
  ensureTelegramChatForwarder,
  teardownTelegramChatForwarder,
} from "./telegramChatForwarder";

const TG_HOST = "https://api.telegram.org";
const DEDUPE_MS = 1500;
const MAX_TEXT = 3500;
/**
 * Window during which repeated permission requests from the same
 * `(sessionId, tool)` pair are silently absorbed into the first one.
 * Bash-loop-style sessions can fire 10+ permission requests in a few
 * seconds; without coalescing each one becomes its own Telegram ping.
 */
const PERM_COALESCE_MS = 60_000;

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

/**
 * Send a notification text. The bridge always tries BOTH channels in
 * parallel when configured:
 *
 *   - Bot API     — fast HTTP, MarkdownV2 formatting, native fallbacks.
 *   - User-client — gram-js MTProto, posts as the operator's account so
 *                   it sidesteps Bot API's "bot can't message bot" /
 *                   group-privacy limits.
 *
 * Either-or-both work: a configured user-client means notifications
 * keep flowing even if the bot is restricted, and vice versa. Failures
 * on one side log a warning and don't block the other.
 *
 * The user-client receives the same `text` but stripped of MarkdownV2
 * escapes, since gram-js posts as plain text by default — operators
 * can switch to HTML / Markdown formatting per-call if they need it.
 */
/**
 * Public counterpart of `sendTelegram` for callers outside this module
 * (e.g. `telegramChatForwarder.ts`). Same fan-out semantics: tries Bot
 * API + user-client in parallel when configured, swallows per-channel
 * errors. Exported so the chat forwarder doesn't have to duplicate the
 * fan-out logic — and so any future caller pipes through the same
 * truncation / formatting / dedup behavior.
 */
export async function sendTelegramRaw(text: string): Promise<void> {
  return sendTelegram(text);
}

async function sendTelegram(text: string): Promise<void> {
  const cfg = envConfig();
  const tasks: Promise<void>[] = [];

  if (cfg) {
    tasks.push(sendViaBot(cfg, text));
  }
  if (isUserClientConfigured()) {
    tasks.push(sendViaUserClient(text));
  }

  if (tasks.length === 0) return;
  // Run in parallel; never reject the outer promise (handlers below
  // swallow per-channel errors so one dead channel doesn't kill the
  // sibling).
  await Promise.allSettled(tasks);
}

/**
 * Per-chat serial queue. Bot API throttles to ~1 msg/sec per chat and
 * ~30 msg/sec global; bursts get 429s that previously dropped messages
 * silently. Serializing per chat keeps us under the local limit, and
 * the retry loop below handles whatever 429 / 5xx still slips through.
 *
 * HMR-safe: pinned onto globalThis like every other stateful map in
 * this codebase (permissionStore, spawnRegistry, meta write queues).
 * Without this, a Next.js dev HMR reload mid-burst would drop the
 * chain head and the new module instance's queue starts from a fresh
 * `Promise.resolve()` — racing the orphan promise's `.finally` that
 * still holds a closure over the old `botQueues` Map.
 */
const G_NOTIFIER = globalThis as unknown as {
  __bridgeTelegramBotQueues?: Map<string, Promise<void>>;
};
const botQueues: Map<string, Promise<void>> =
  G_NOTIFIER.__bridgeTelegramBotQueues ?? new Map<string, Promise<void>>();
G_NOTIFIER.__bridgeTelegramBotQueues = botQueues;
function enqueueBotSend(
  chatId: string,
  job: () => Promise<void>,
): Promise<void> {
  const prev = botQueues.get(chatId) ?? Promise.resolve();
  const next = prev.then(job, job).finally(() => {
    if (botQueues.get(chatId) === next) botQueues.delete(chatId);
  });
  botQueues.set(chatId, next);
  return next;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function sendViaBot(
  cfg: { token: string; chatId: string },
  text: string,
): Promise<void> {
  const truncated = text.length > MAX_TEXT ? text.slice(0, MAX_TEXT) + "…" : text;
  const url = `${TG_HOST}/bot${encodeURIComponent(cfg.token)}/sendMessage`;

  await enqueueBotSend(cfg.chatId, async () => {
    // Up to 4 attempts. 429 honors `parameters.retry_after`; 5xx and
    // network errors back off exponentially (0.5s, 1s, 2s) so a flaky
    // network or transient Telegram outage doesn't drop notifications.
    let plainFallbackUsed = false;
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        const r = await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            chat_id: cfg.chatId,
            text: truncated,
            // After a MarkdownV2 parse error we resend without parse_mode
            // so the user still sees the message — better a raw message
            // than silently dropped formatting noise.
            ...(plainFallbackUsed ? {} : { parse_mode: "MarkdownV2" }),
            disable_web_page_preview: true,
          }),
          // 10s upper bound: Telegram is fast in the happy path; we
          // don't want a slow connection to wedge the queue.
          signal: AbortSignal.timeout(10_000),
        });
        if (r.ok) return;

        const bodyText = await r.text().catch(() => "");
        // 429 — Telegram tells us how long to wait via the parsed body.
        if (r.status === 429) {
          const retryAfter = parseRetryAfter(bodyText, r.headers.get("retry-after"));
          if (attempt < 3) {
            await sleep(retryAfter);
            continue;
          }
        }
        // 5xx / 502 / 504 — transient. Back off and retry.
        if (r.status >= 500 && attempt < 3) {
          await sleep(500 * Math.pow(2, attempt));
          continue;
        }
        // 400 with "can't parse entities" → MarkdownV2 escaping went
        // sideways for some payload; resend as plain text instead of
        // dropping the notification entirely.
        if (
          r.status === 400 &&
          /can't parse entities|can't find end of/i.test(bodyText) &&
          !plainFallbackUsed &&
          attempt < 3
        ) {
          plainFallbackUsed = true;
          continue;
        }
        console.warn(`[telegram] send failed: ${r.status} ${bodyText.slice(0, 200)}`);
        return;
      } catch (err) {
        // AbortError / network error — retry with backoff.
        if (attempt < 3) {
          await sleep(500 * Math.pow(2, attempt));
          continue;
        }
        console.warn(`[telegram] send error: ${(err as Error).message}`);
        return;
      }
    }
  });
}

/**
 * Telegram returns 429 like:
 *   { ok:false, error_code:429, parameters:{ retry_after: 5 } }
 * Some proxies also surface a `Retry-After` header. Prefer the body
 * field (more accurate), fall back to the header, default to 1s. Cap
 * at 30s so a misconfigured server can't park the queue forever.
 */
function parseRetryAfter(body: string, header: string | null): number {
  try {
    const parsed = JSON.parse(body) as {
      parameters?: { retry_after?: unknown };
    };
    const ra = parsed.parameters?.retry_after;
    if (typeof ra === "number" && ra > 0) {
      return Math.min(30_000, Math.ceil(ra * 1000));
    }
  } catch { /* not JSON */ }
  if (header) {
    const n = Number(header);
    if (Number.isFinite(n) && n > 0) {
      return Math.min(30_000, Math.ceil(n * 1000));
    }
  }
  return 1000;
}

async function sendViaUserClient(text: string): Promise<void> {
  // gram-js posts plain text by default; un-escape the MarkdownV2
  // syntax we added for the bot side so the user-account version
  // reads naturally instead of `\.\!\(...`.
  const plain = text.replace(/\\([_*[\]()~`>#+\-=|{}.!\\])/g, "$1");
  const truncated = plain.length > MAX_TEXT ? plain.slice(0, MAX_TEXT) + "…" : plain;
  try {
    await sendUserMessage(truncated);
  } catch (err) {
    console.warn(`[telegram-user] send error: ${(err as Error).message}`);
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

/**
 * Decide whether a `transition` event should produce a Telegram ping
 * given the operator's notification level.
 *
 *   minimal — coordinator done/failed, OR any child `failed`. Child
 *             `done` is filtered out (the coordinator's own done is
 *             the actionable signal).
 *   normal  — same as minimal PLUS child `done`. Surfaces "this
 *             specific subagent finished" without the per-bash-call
 *             firehose of verbose.
 *   verbose — every done/failed transition (legacy behavior).
 */
function shouldNotifyTransition(
  level: TelegramNotificationLevel,
  role: string,
  status: "done" | "failed",
): boolean {
  if (level === "verbose") return true;
  const isCoordinator = role === "coordinator";
  if (status === "failed") return true;
  // status === "done":
  if (level === "minimal") return isCoordinator;
  // normal:
  return true;
}

/**
 * Decide whether a `task-section` event should ping Telegram.
 *
 *   minimal — only `BLOCKED` and `DONE — not yet archived`.
 *             These are the moves that mean "I need the operator's
 *             attention". Started / Resumed / Reset to TODO are
 *             bookkeeping.
 *   normal  — same as minimal PLUS first-time `DOING` (Started, not
 *             Resumed). Lets the operator know a task actually picked
 *             up workers without firing on every shuffle.
 *   verbose — every section move (legacy).
 */
function shouldNotifySection(
  level: TelegramNotificationLevel,
  prev: string | undefined,
  next: string,
): boolean {
  if (level === "verbose") return true;
  if (next === SECTION_BLOCKED || next === SECTION_DONE) return true;
  if (level === "normal" && next === SECTION_DOING && prev === SECTION_TODO) return true;
  return false;
}

/**
 * Build the trailing "open in UI" line for a Telegram message. Empty
 * string when the operator hasn't set a public URL — we don't ship a
 * `localhost:7777` link to a phone, since the phone can't reach it.
 *
 * Telegram MarkdownV2 inline-link form: `[label](url)`. Labels and the
 * URL itself need escaping for the reserved set (we already do that
 * for the rest of the body); a bare `\n[Open](https://…/tasks/t_x)`
 * renders as a tappable link in mobile clients.
 */
function renderTaskLink(taskId: string): string {
  const base = getPublicBridgeUrl();
  if (!base || base.startsWith("http://localhost")) return "";
  // taskId is `t_YYYYMMDD_NNN`, all URL-safe — but escape the closing
  // parens / brackets MarkdownV2 reserves anyway, in case the format
  // ever loosens.
  const url = `${base}/tasks/${taskId}`.replace(/([)\\])/g, "\\$1");
  return `\n[Open in bridge](${url})`;
}

function onMetaChange(ev: MetaChangeEvent): void {
  const level = getManifestTelegramSettings().notificationLevel;
  // Run lifecycle: child / coordinator finished or crashed.
  if (ev.kind === "transition" && ev.run) {
    const next = ev.run.status;
    if (next !== "done" && next !== "failed") return;
    if (!shouldNotifyTransition(level, ev.run.role, next)) return;
    const dedupeKey = `meta:${ev.taskId}:${ev.sessionId}:${next}`;
    if (!shouldSend(dedupeKey)) return;

    // Coordinator completion gets the rich summary treatment — instead
    // of "✅ coordinator completed" + a separate stream of chat
    // fragments, send ONE consolidated message containing the verdict
    // and summary.md body. Falls back to the bland message only when
    // summary.md is missing AND status is `failed` (the coordinator
    // crashed before writing). Missing summary on `done` is suppressed
    // entirely because the deferred-flip + nudge path
    // (`coordinatorNudge` + `runLifecycle.succeedRun`) is mid-flight —
    // a second turn will resume the coordinator and a real summary
    // will land soon. Pinging "completed" now would mislead the
    // operator into thinking the task is shippable when it isn't.
    if (ev.run.role === "coordinator") {
      const summary = readSummaryMd(ev.taskId);
      if (summary) {
        void sendTelegram(renderCoordinatorSummaryMessage({
          taskId: ev.taskId,
          summary,
          status: next,
        }));
        return;
      }
      if (next === "done") {
        // Premature exit — let the nudge cycle bring it back.
        return;
      }
      // Fall through to bland "⚠️ coordinator failed" for failures
      // with no summary on disk — the operator needs to know.
    }

    const role = escapeMarkdownV2(ev.run.role);
    const repo = escapeMarkdownV2(ev.run.repo);
    const taskId = escapeMarkdownV2(ev.taskId);
    const icon = next === "done" ? "✅" : "⚠️";
    const verb = next === "done" ? "completed" : "failed";
    const text =
      `${icon} *${role}* ${verb}\n` +
      `task \`${taskId}\` · repo \`${repo}\`` +
      renderTaskLink(ev.taskId);
    void sendTelegram(text);
    return;
  }
  // User-initiated section transitions: UI tick the complete checkbox,
  // or move TODO ↔ DOING / BLOCKED via the kanban board / API.
  if (ev.kind === "task-section" && ev.nextSection) {
    if (!shouldNotifySection(level, ev.prevSection, ev.nextSection)) return;
    const dedupeKey = `task-section:${ev.taskId}:${ev.nextSection}:${ev.taskChecked}`;
    if (!shouldSend(dedupeKey)) return;
    const taskId = escapeMarkdownV2(ev.taskId);
    const title = escapeMarkdownV2(
      (ev.taskTitle ?? "").slice(0, 120) || "(untitled)",
    );
    const icon = sectionIcon(ev.nextSection);
    const verb = sectionVerb(ev.prevSection, ev.nextSection, ev.taskChecked);
    const text =
      `${icon} *${verb}*\n` +
      `task \`${taskId}\` — ${title}` +
      renderTaskLink(ev.taskId);
    void sendTelegram(text);
    return;
  }
}

/**
 * Read `sessions/<taskId>/summary.md` and return its trimmed content,
 * or `null` if the file is missing / empty / unreadable. The coordinator
 * is contracted to write this file on completion (per
 * `prompts/coordinator-playbook.md` §5); when it lands we use it as the
 * canonical Telegram message body so the operator gets the actual
 * shipping summary instead of an opaque "✅ completed" ping.
 */
export function readSummaryMd(taskId: string): string | null {
  const path = join(SESSIONS_DIR, taskId, "summary.md");
  if (!existsSync(path)) return null;
  try {
    const content = readFileSync(path, "utf8").trim();
    return content.length > 0 ? content : null;
  } catch {
    return null;
  }
}

/**
 * Classify the verdict from the first line of summary.md. The four
 * verdicts coordinators are contracted to emit are the canonical set
 * (per coordinator-playbook §5 / `forwardChatImportantPatterns`); anything
 * else falls back to a neutral icon so an off-script summary still gets
 * delivered. Returns the icon + a human label for the header.
 */
export function classifyVerdict(firstLine: string): { icon: string; label: string } {
  const upper = firstLine.toUpperCase();
  if (upper.includes("READY FOR REVIEW")) {
    return { icon: "🎉", label: "Ready for review" };
  }
  if (upper.includes("AWAITING DECISION")) {
    return { icon: "❓", label: "Awaiting decision" };
  }
  if (upper.includes("BLOCKED")) {
    return { icon: "🔴", label: "Blocked" };
  }
  if (upper.includes("PARTIAL")) {
    return { icon: "🟠", label: "Partial" };
  }
  return { icon: "📌", label: "Summary" };
}

/**
 * Compose the consolidated coordinator-done Telegram message: header
 * with verdict icon + label + task id, then the summary body (escaped
 * for MarkdownV2), capped at `MAX_TEXT - reserved` so the trailing
 * "Open in bridge" link always lands cleanly. Failure-status `failed`
 * with a summary present is rare (the coordinator usually doesn't get
 * to write summary on a crash), but if it happens we honor the file —
 * the operator gets the model's best-effort context.
 */
export function renderCoordinatorSummaryMessage(args: {
  taskId: string;
  summary: string;
  status: "done" | "failed";
}): string {
  const lines = args.summary.split(/\r?\n/);
  const firstLine = (lines[0] ?? "").trim();
  const { icon, label } =
    args.status === "failed"
      ? { icon: "⚠️", label: "Coordinator failed" }
      : classifyVerdict(firstLine);

  const taskId = escapeMarkdownV2(args.taskId);
  const headerLine = `${icon} *${escapeMarkdownV2(label)}* — task \`${taskId}\``;
  const link = renderTaskLink(args.taskId);

  // Reserve enough room for header + link + ellipsis so a long
  // summary doesn't push the link off the truncation cliff in
  // `sendViaBot`. 600 chars is a generous upper bound covering the
  // worst-case escaped link URL + header.
  const reserved = headerLine.length + link.length + 600;
  const bodyCap = Math.max(500, MAX_TEXT - reserved);
  const body = args.summary.length > bodyCap
    ? args.summary.slice(0, bodyCap) + "\n…"
    : args.summary;
  const escapedBody = escapeMarkdownV2(body);

  return `${headerLine}\n\n${escapedBody}${link}`;
}

function sectionIcon(section: string): string {
  switch (section) {
    case SECTION_TODO: return "⚪";
    case SECTION_DOING: return "🟡";
    case SECTION_BLOCKED: return "🔴";
    case SECTION_DONE: return "🎉";
    default: return "📌";
  }
}

function sectionVerb(
  prev: string | undefined,
  next: string,
  checked: boolean | undefined,
): string {
  if (next === SECTION_DONE && checked) return "Marked complete";
  if (next === SECTION_DONE) return "Moved to done";
  if (next === SECTION_BLOCKED) return "Blocked";
  if (next === SECTION_DOING) return prev === SECTION_TODO ? "Started" : "Resumed";
  if (next === SECTION_TODO) return "Reset to TODO";
  return `Section: ${next}`;
}

/**
 * Per-`(session, tool)` coalescing window. The first request wakes the
 * operator; follow-ups within `PERM_COALESCE_MS` are silently absorbed
 * because the operator only needs ONE prompt per "session X wants tool
 * Y" pattern — they'll see the rest in the bridge UI.
 *
 * In `verbose` mode we skip the coalescer entirely so debugging the
 * permission flow itself still gets a per-request signal.
 */
const permCoalesce = new Map<string, number>();

function shouldCoalescePermission(
  level: TelegramNotificationLevel,
  sessionId: string,
  tool: string,
): boolean {
  if (level === "verbose") return false;
  const key = `${sessionId}:${tool}`;
  const now = Date.now();
  const last = permCoalesce.get(key) ?? 0;
  if (now - last < PERM_COALESCE_MS) return true;
  permCoalesce.set(key, now);
  // Bound the map: drop entries older than 4× the window. They can't
  // coalesce future requests anyway and unbounded growth in a long-
  // running bridge eventually shows up in heap snapshots.
  if (permCoalesce.size > 256) {
    const cutoff = now - PERM_COALESCE_MS * 4;
    for (const [k, t] of permCoalesce) {
      if (t < cutoff) permCoalesce.delete(k);
    }
  }
  return false;
}

function onPermission(req: PendingRequest): void {
  const level = getManifestTelegramSettings().notificationLevel;
  if (shouldCoalescePermission(level, req.sessionId, req.tool)) return;
  const dedupeKey = `perm:${req.sessionId}:${req.requestId}`;
  if (!shouldSend(dedupeKey)) return;
  const tool = escapeMarkdownV2(req.tool);
  const sid = escapeMarkdownV2(req.sessionId.slice(0, 8));
  // Surface the first 8 chars of the requestId so the operator can
  // reply with `/allow <prefix>` or `/deny <prefix>` from chat — the
  // command handler accepts any prefix ≥6 chars and looks up the full
  // request across all pending. Backticks let mobile Telegram tap-to-
  // copy the prefix without selecting surrounding text.
  const reqPrefix = escapeMarkdownV2(req.requestId.slice(0, 8));
  const text =
    `🔐 *Permission needed*\n` +
    `tool \`${tool}\` · session \`${sid}\`\n` +
    `req \`${reqPrefix}\` — reply \`/allow ${reqPrefix}\` or \`/deny ${reqPrefix}\``;
  void sendTelegram(text);
}

export function ensureTelegramNotifier(): void {
  if (state.installed) return;
  // Either channel being configured is enough to light up notifier —
  // outbound `sendTelegram` will fan-out to whichever one(s) actually
  // have credentials at send time.
  const hasBot = envConfig() !== null;
  const hasUser = isUserClientConfigured();
  if (!hasBot && !hasUser) return;
  state.installed = true;
  state.unsubscribers.push(subscribeMetaAll(onMetaChange));
  state.unsubscribers.push(subscribeAllPermissions(onPermission));
  // Inbound side: long-poll Telegram for slash commands so the operator
  // can run `/tasks`, `/done <id>`, etc. from their phone. The poller
  // checks for bot creds itself and is a no-op when only the
  // user-client is configured; user-client inbound is wired separately
  // below.
  if (hasBot) startTelegramCommandPoller();
  if (hasUser) {
    void startTelegramUserCommandListener().catch((err) => {
      console.warn(
        "[telegram-user] inbound listener failed to start:",
        (err as Error).message,
      );
    });
  }
  // Chat forwarder mirrors assistant prose from spawned sessions.
  // Self-gates on `forwardChat` per-event, so installing it here is
  // safe even when the operator hasn't enabled forwarding yet — flipping
  // the setting takes effect on the next `spawned` event without a
  // teardown / reinstall cycle.
  ensureTelegramChatForwarder();
  console.info(
    `[telegram] notifier installed (bot=${hasBot}, user=${hasUser})`,
  );
}

export function teardownTelegramNotifier(): void {
  for (const fn of state.unsubscribers.splice(0)) {
    try { fn(); } catch { /* ignore */ }
  }
  stopTelegramCommandPoller();
  void stopTelegramUserCommandListener();
  teardownTelegramChatForwarder();
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
