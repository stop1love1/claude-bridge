import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { subscribeMetaAll, readMeta, type MetaChangeEvent } from "./meta";
import { computeGateStatus, renderGateStatusLine, type GateStatus } from "./gateStatus";
import { subscribeAllPermissions, type PendingRequest } from "./permissionStore";
import { subscribeLoginApprovals, type PendingLogin } from "./loginApprovals";
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
import { sendPushToAll } from "./webPush";
import { sendTelegramApiMessage } from "./telegramSendRetry";
import { logInfo, logWarn } from "./log";

function notifyPush(payload: { title: string; body: string; url?: string }): void {
  try {
    void sendPushToAll(payload).catch((err) => {
      logWarn("webpush", "fan-out failed", { error: (err as Error)?.message ?? String(err) });
    });
  } catch (err) {
    logWarn("webpush", "fan-out threw synchronously", { error: (err as Error)?.message ?? String(err) });
  }
}

const TG_HOST = "https://api.telegram.org";
const DEDUPE_MS = 1500;
const MAX_TEXT = 3500;
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

function envConfig(): { token: string; chatId: string } | null {
  const settings = getManifestTelegramSettings();
  if (settings.botToken && settings.chatId) {
    return { token: settings.botToken, chatId: settings.chatId };
  }
  return null;
}

export function escapeMarkdownV2(s: string): string {
  return s.replace(/([_*[\]()~`>#+\-=|{}.!\\])/g, "\\$1");
}

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
  await Promise.allSettled(tasks);
}

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

async function sendViaBot(
  cfg: { token: string; chatId: string },
  text: string,
): Promise<void> {
  const truncated = text.length > MAX_TEXT ? text.slice(0, MAX_TEXT) + "…" : text;
  const url = `${TG_HOST}/bot${encodeURIComponent(cfg.token)}/sendMessage`;

  await enqueueBotSend(cfg.chatId, () =>
    sendTelegramApiMessage(
      url,
      (plainFallbackUsed) => ({
        chat_id: cfg.chatId,
        text: truncated,
        ...(plainFallbackUsed ? {} : { parse_mode: "MarkdownV2" }),
        disable_web_page_preview: true,
      }),
      "telegram",
    ),
  );
}

async function sendViaUserClient(text: string): Promise<void> {
  const plain = text.replace(/\\([_*[\]()~`>#+\-=|{}.!\\])/g, "$1");
  const truncated = plain.length > MAX_TEXT ? plain.slice(0, MAX_TEXT) + "…" : plain;
  try {
    await sendUserMessage(truncated);
  } catch (err) {
    logWarn("telegram-user", `send error: ${(err as Error).message}`);
  }
}

function shouldSend(key: string): boolean {
  const now = Date.now();
  const last = state.recent.get(key) ?? 0;
  if (now - last < DEDUPE_MS) return false;
  state.recent.set(key, now);
  if (state.recent.size > 256) {
    const cutoff = now - DEDUPE_MS * 4;
    for (const [k, t] of state.recent) {
      if (t < cutoff) state.recent.delete(k);
    }
  }
  return true;
}

function shouldNotifyTransition(
  level: TelegramNotificationLevel,
  role: string,
  status: "done" | "failed",
): boolean {
  if (level === "verbose") return true;
  const isCoordinator = role === "coordinator";
  if (status === "failed") return true;
  if (level === "minimal") return isCoordinator;
  return true;
}

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

function renderTaskLink(taskId: string): string {
  const base = getPublicBridgeUrl();
  if (!base || base.startsWith("http://localhost")) return "";
  const url = `${base}/tasks/${taskId}`.replace(/([)\\])/g, "\\$1");
  return `\n[Open in bridge](${url})`;
}

function onMetaChange(ev: MetaChangeEvent): void {
  const level = getManifestTelegramSettings().notificationLevel;
  if (ev.kind === "transition" && ev.run) {
    const next = ev.run.status;
    if (next !== "done" && next !== "failed") return;
    if (!shouldNotifyTransition(level, ev.run.role, next)) return;
    const dedupeKey = `meta:${ev.taskId}:${ev.sessionId}:${next}`;
    if (!shouldSend(dedupeKey)) return;

    if (ev.run.role === "coordinator") {
      const summary = readSummaryMd(ev.taskId);
      if (summary) {
        const taskMeta = readMeta(join(SESSIONS_DIR, ev.taskId));
        const gateStatus: GateStatus | undefined = taskMeta ? computeGateStatus(taskMeta) : undefined;
        void sendTelegram(renderCoordinatorSummaryMessage({
          taskId: ev.taskId,
          summary,
          status: next,
          gateStatus,
        }));
        const firstLine = (summary.split(/\r?\n/)[0] ?? "").trim();
        const { label } =
          next === "failed"
            ? { label: "Coordinator failed" }
            : classifyVerdict(firstLine);
        notifyPush({
          title: `${label} — ${ev.taskId}`,
          body: summary.slice(0, 200),
          url: `/tasks/${ev.taskId}`,
        });
        return;
      }
      if (next === "done") {
        return;
      }
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
    if (ev.nextSection === SECTION_BLOCKED) {
      notifyPush({
        title: `🔴 Blocked — ${ev.taskId}`,
        body: (ev.taskTitle ?? "").slice(0, 200) || "(untitled)",
        url: `/tasks/${ev.taskId}`,
      });
    }
    return;
  }
  if (ev.kind === "intake-awaiting-approval") {
    if (!shouldNotifyIntakeAwaitingApproval(level)) return;
    const dedupeKey = `intake-awaiting:${ev.taskId}`;
    if (!shouldSend(dedupeKey)) return;
    const text =
      renderPlanAwaitingApprovalMessage({
        taskId: ev.taskId,
        taskTitle: ev.taskTitle ?? "",
      }) + renderTaskLink(ev.taskId);
    void sendTelegram(text);
    notifyPush({
      title: `📋 Plan ready for review — ${ev.taskId}`,
      body: (ev.taskTitle ?? "").slice(0, 200) || "(untitled)",
      url: `/tasks/${ev.taskId}`,
    });
    return;
  }
}

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

export function renderCoordinatorSummaryMessage(args: {
  taskId: string;
  summary: string;
  status: "done" | "failed";
  gateStatus?: GateStatus;
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

  const gateLine = args.gateStatus ? renderGateStatusLine(args.gateStatus) : "";
  const gateBlock = gateLine ? `\n\n${escapeMarkdownV2(gateLine)}` : "";

  const reserved = headerLine.length + gateBlock.length + link.length + 600;
  const bodyCap = Math.max(500, MAX_TEXT - reserved);
  const body = args.summary.length > bodyCap
    ? args.summary.slice(0, bodyCap) + "\n…"
    : args.summary;
  const escapedBody = escapeMarkdownV2(body);

  return `${headerLine}\n\n${escapedBody}${gateBlock}${link}`;
}

function shouldNotifyIntakeAwaitingApproval(level: TelegramNotificationLevel): boolean {
  return level !== "minimal";
}

export function renderPlanAwaitingApprovalMessage(args: {
  taskId: string;
  taskTitle: string;
}): string {
  const id = escapeMarkdownV2(args.taskId);
  const title = escapeMarkdownV2(args.taskTitle.trim() || "(untitled)");
  return (
    `📋 *Plan ready for review* — ${title}\n` +
    `\`/plan ${id}\` · \`/approve ${id}\` · \`/replan ${id} <note>\``
  );
}

export function renderPendingLoginMessage(entry: PendingLogin): string {
  const ua = escapeMarkdownV2(entry.userAgent.slice(0, 120));
  const ip = escapeMarkdownV2(entry.remoteIp);
  const prefix = escapeMarkdownV2(entry.id.slice(0, 8));
  return `🔐 New device login pending: ${ua} from \`${ip}\` — \`/approvelogin ${prefix}\``;
}

function shouldNotifyPendingLogin(level: TelegramNotificationLevel): boolean {
  return level !== "minimal";
}

function onPendingLogin(entry: PendingLogin): void {
  const level = getManifestTelegramSettings().notificationLevel;
  if (!shouldNotifyPendingLogin(level)) return;
  const dedupeKey = `login-pending:${entry.id}`;
  if (!shouldSend(dedupeKey)) return;
  void sendTelegram(renderPendingLoginMessage(entry));
  notifyPush({
    title: "🔐 New device login pending",
    body: `${entry.userAgent.slice(0, 120)} from ${entry.remoteIp}`,
  });
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

const GPC = globalThis as unknown as { __bridgePermCoalesce?: Map<string, number> };
const permCoalesce: Map<string, number> = GPC.__bridgePermCoalesce ?? new Map<string, number>();
GPC.__bridgePermCoalesce = permCoalesce;

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
  const reqPrefix = escapeMarkdownV2(req.requestId.slice(0, 8));
  const text =
    `🔐 *Permission needed*\n` +
    `tool \`${tool}\` · session \`${sid}\`\n` +
    `req \`${reqPrefix}\` — reply \`/allow ${reqPrefix}\` or \`/deny ${reqPrefix}\``;
  void sendTelegram(text);
  notifyPush({
    title: "🔐 Permission needed",
    body: `tool ${req.tool} · session ${req.sessionId.slice(0, 8)}`,
  });
}

export function ensureTelegramNotifier(): void {
  if (state.installed) return;
  const hasBot = envConfig() !== null;
  const hasUser = isUserClientConfigured();
  state.installed = true;
  state.unsubscribers.push(subscribeMetaAll(onMetaChange));
  state.unsubscribers.push(subscribeAllPermissions(onPermission));
  state.unsubscribers.push(subscribeLoginApprovals(onPendingLogin));
  if (hasBot) startTelegramCommandPoller();
  if (hasUser) {
    void startTelegramUserCommandListener().catch((err) => {
      logWarn(
        "telegram-user",
        "inbound listener failed to start",
        { error: (err as Error).message },
      );
    });
  }
  ensureTelegramChatForwarder();
  logInfo(
    "telegram",
    `notifier installed (bot=${hasBot}, user=${hasUser})`,
  );
}

export function teardownTelegramNotifier(): void {
  for (const fn of state.unsubscribers.splice(0)) {
    try { fn(); } catch { }
  }
  stopTelegramCommandPoller();
  void stopTelegramUserCommandListener();
  teardownTelegramChatForwarder();
  state.installed = false;
}

function extractTelegramError(body: string): string {
  if (!body) return "(empty body)";
  try {
    const parsed = JSON.parse(body) as { description?: unknown };
    if (typeof parsed.description === "string" && parsed.description.trim()) {
      return parsed.description.trim().slice(0, 200);
    }
  } catch {
  }
  return body.slice(0, 200);
}

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
