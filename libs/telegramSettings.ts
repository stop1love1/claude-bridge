
import { updateBridgeManifest } from "./bridgeManifest";
import type { BridgeManifest } from "./apps/types";
import { readManifest } from "./apps/manifest";

export interface TelegramUserSettings {
  apiId: number;
  apiHash: string;
  session: string;
  targetChatId: string;
}

export const DEFAULT_TELEGRAM_USER_SETTINGS: TelegramUserSettings = {
  apiId: 0,
  apiHash: "",
  session: "",
  targetChatId: "",
};

export type TelegramForwardChat = "off" | "coordinator-only" | "all";

export const DEFAULT_FORWARD_CHAT: TelegramForwardChat = "off";
export const DEFAULT_FORWARD_CHAT_MIN_CHARS = 40;

export type TelegramNotificationLevel = "minimal" | "normal" | "verbose";

export const DEFAULT_NOTIFICATION_LEVEL: TelegramNotificationLevel = "normal";

export type TelegramForwardChatFilter = "important-only" | "all";

export const DEFAULT_FORWARD_CHAT_FILTER: TelegramForwardChatFilter =
  "important-only";

export interface TelegramSettings {
  botToken: string;
  chatId: string;
  user: TelegramUserSettings;
  forwardChat: TelegramForwardChat;
  forwardChatMinChars: number;
  notificationLevel: TelegramNotificationLevel;
  forwardChatFilter: TelegramForwardChatFilter;
  forwardChatImportantPatterns: string[];
}

export const DEFAULT_FORWARD_CHAT_IMPORTANT_PATTERNS: ReadonlyArray<string> = [
  "NEEDS-DECISION",
  "BLOCKED",
  "READY FOR REVIEW",
];

export const DEFAULT_TELEGRAM_SETTINGS: TelegramSettings = {
  botToken: "",
  chatId: "",
  user: { ...DEFAULT_TELEGRAM_USER_SETTINGS },
  forwardChat: DEFAULT_FORWARD_CHAT,
  forwardChatMinChars: DEFAULT_FORWARD_CHAT_MIN_CHARS,
  notificationLevel: DEFAULT_NOTIFICATION_LEVEL,
  forwardChatFilter: DEFAULT_FORWARD_CHAT_FILTER,
  forwardChatImportantPatterns: [...DEFAULT_FORWARD_CHAT_IMPORTANT_PATTERNS],
};

function normalizeTelegramUserSettings(raw: unknown): TelegramUserSettings {
  if (!raw || typeof raw !== "object") {
    return { ...DEFAULT_TELEGRAM_USER_SETTINGS };
  }
  const r = raw as Partial<TelegramUserSettings>;
  const apiId = typeof r.apiId === "number" && Number.isFinite(r.apiId) ? Math.floor(r.apiId) : 0;
  const apiHash = typeof r.apiHash === "string" ? r.apiHash.trim() : "";
  const session = typeof r.session === "string" ? r.session.trim() : "";
  const targetChatId = typeof r.targetChatId === "string" ? r.targetChatId.trim() : "";
  return { apiId, apiHash, session, targetChatId };
}

function normalizeForwardChat(raw: unknown): TelegramForwardChat {
  if (raw === "coordinator-only" || raw === "all" || raw === "off") return raw;
  return DEFAULT_FORWARD_CHAT;
}

function normalizeForwardChatMinChars(raw: unknown): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    return DEFAULT_FORWARD_CHAT_MIN_CHARS;
  }
  const v = Math.floor(raw);
  if (v < 0) return 0;
  if (v > 5000) return 5000;
  return v;
}

function normalizeNotificationLevel(raw: unknown): TelegramNotificationLevel {
  if (raw === "minimal" || raw === "normal" || raw === "verbose") return raw;
  return DEFAULT_NOTIFICATION_LEVEL;
}

function normalizeForwardChatFilter(raw: unknown): TelegramForwardChatFilter {
  if (raw === "important-only" || raw === "all") return raw;
  return DEFAULT_FORWARD_CHAT_FILTER;
}

function normalizeForwardChatImportantPatterns(raw: unknown): string[] {
  if (!Array.isArray(raw)) {
    return [...DEFAULT_FORWARD_CHAT_IMPORTANT_PATTERNS];
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string") continue;
    const trimmed = item.trim();
    if (!trimmed) continue;
    const capped = trimmed.length > 200 ? trimmed.slice(0, 200) : trimmed;
    const key = capped.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(capped);
    if (out.length >= 32) break;
  }
  return out.length > 0 ? out : [...DEFAULT_FORWARD_CHAT_IMPORTANT_PATTERNS];
}

export function getManifestTelegramSettings(): TelegramSettings {
  const m = readManifest();
  const tg = (m as {
    telegram?: {
      botToken?: unknown;
      chatId?: unknown;
      user?: unknown;
      forwardChat?: unknown;
      forwardChatMinChars?: unknown;
      notificationLevel?: unknown;
      forwardChatFilter?: unknown;
      forwardChatImportantPatterns?: unknown;
    };
  }).telegram;
  if (!tg || typeof tg !== "object") {
    return {
      botToken: (process.env.TELEGRAM_BOT_TOKEN ?? "").trim(),
      chatId: (process.env.TELEGRAM_CHAT_ID ?? "").trim(),
      user: { ...DEFAULT_TELEGRAM_USER_SETTINGS },
      forwardChat: DEFAULT_FORWARD_CHAT,
      forwardChatMinChars: DEFAULT_FORWARD_CHAT_MIN_CHARS,
      notificationLevel: DEFAULT_NOTIFICATION_LEVEL,
      forwardChatFilter: DEFAULT_FORWARD_CHAT_FILTER,
      forwardChatImportantPatterns: [...DEFAULT_FORWARD_CHAT_IMPORTANT_PATTERNS],
    };
  }
  const botToken = typeof tg.botToken === "string" ? tg.botToken.trim() : "";
  const chatId = typeof tg.chatId === "string" ? tg.chatId.trim() : "";
  const user = normalizeTelegramUserSettings(tg.user);
  const forwardChat = normalizeForwardChat(tg.forwardChat);
  const forwardChatMinChars = normalizeForwardChatMinChars(tg.forwardChatMinChars);
  const notificationLevel = normalizeNotificationLevel(tg.notificationLevel);
  const forwardChatFilter = normalizeForwardChatFilter(tg.forwardChatFilter);
  const forwardChatImportantPatterns = normalizeForwardChatImportantPatterns(
    tg.forwardChatImportantPatterns,
  );
  if (!botToken || !chatId) {
    const envToken = (process.env.TELEGRAM_BOT_TOKEN ?? "").trim();
    const envChat = (process.env.TELEGRAM_CHAT_ID ?? "").trim();
    return {
      botToken: botToken || envToken,
      chatId: chatId || envChat,
      user,
      forwardChat,
      forwardChatMinChars,
      notificationLevel,
      forwardChatFilter,
      forwardChatImportantPatterns,
    };
  }
  return {
    botToken,
    chatId,
    user,
    forwardChat,
    forwardChatMinChars,
    notificationLevel,
    forwardChatFilter,
    forwardChatImportantPatterns,
  };
}

export function setManifestTelegramSettings(
  patch: {
    botToken?: string;
    chatId?: string;
    user?: Partial<TelegramUserSettings>;
    forwardChat?: TelegramForwardChat;
    forwardChatMinChars?: number;
    notificationLevel?: TelegramNotificationLevel;
    forwardChatFilter?: TelegramForwardChatFilter;
    forwardChatImportantPatterns?: string[];
  },
): TelegramSettings {
  const current = getManifestTelegramSettings();
  const userPatch = patch.user;
  const nextUser: TelegramUserSettings = userPatch
    ? {
        apiId:
          typeof userPatch.apiId === "number" && Number.isFinite(userPatch.apiId)
            ? Math.floor(userPatch.apiId)
            : current.user.apiId,
        apiHash:
          typeof userPatch.apiHash === "string"
            ? userPatch.apiHash.trim()
            : current.user.apiHash,
        session:
          typeof userPatch.session === "string"
            ? userPatch.session.trim()
            : current.user.session,
        targetChatId:
          typeof userPatch.targetChatId === "string"
            ? userPatch.targetChatId.trim()
            : current.user.targetChatId,
      }
    : current.user;
  const next: TelegramSettings = {
    botToken:
      typeof patch.botToken === "string"
        ? patch.botToken.trim()
        : current.botToken,
    chatId:
      typeof patch.chatId === "string" ? patch.chatId.trim() : current.chatId,
    user: nextUser,
    forwardChat:
      patch.forwardChat !== undefined
        ? normalizeForwardChat(patch.forwardChat)
        : current.forwardChat,
    forwardChatMinChars:
      patch.forwardChatMinChars !== undefined
        ? normalizeForwardChatMinChars(patch.forwardChatMinChars)
        : current.forwardChatMinChars,
    notificationLevel:
      patch.notificationLevel !== undefined
        ? normalizeNotificationLevel(patch.notificationLevel)
        : current.notificationLevel,
    forwardChatFilter:
      patch.forwardChatFilter !== undefined
        ? normalizeForwardChatFilter(patch.forwardChatFilter)
        : current.forwardChatFilter,
    forwardChatImportantPatterns:
      patch.forwardChatImportantPatterns !== undefined
        ? normalizeForwardChatImportantPatterns(patch.forwardChatImportantPatterns)
        : current.forwardChatImportantPatterns,
  };
  const userEmpty =
    next.user.apiId === 0 &&
    next.user.apiHash === "" &&
    next.user.session === "" &&
    next.user.targetChatId === "";
  const importantPatternsDefault =
    next.forwardChatImportantPatterns.length === DEFAULT_FORWARD_CHAT_IMPORTANT_PATTERNS.length &&
    next.forwardChatImportantPatterns.every(
      (p, i) => p === DEFAULT_FORWARD_CHAT_IMPORTANT_PATTERNS[i],
    );
  const forwardChatDefault =
    next.forwardChat === DEFAULT_FORWARD_CHAT &&
    next.forwardChatMinChars === DEFAULT_FORWARD_CHAT_MIN_CHARS &&
    next.notificationLevel === DEFAULT_NOTIFICATION_LEVEL &&
    next.forwardChatFilter === DEFAULT_FORWARD_CHAT_FILTER &&
    importantPatternsDefault;
  const allEmpty =
    next.botToken === "" && next.chatId === "" && userEmpty && forwardChatDefault;
  updateBridgeManifest((m) => {
    const updatedManifest: BridgeManifest = { ...(m as BridgeManifest) };
    if (allEmpty) {
      delete (updatedManifest as { telegram?: TelegramSettings }).telegram;
    } else {
      const persisted: {
        botToken: string;
        chatId: string;
        user?: TelegramUserSettings;
        forwardChat?: TelegramForwardChat;
        forwardChatMinChars?: number;
        notificationLevel?: TelegramNotificationLevel;
        forwardChatFilter?: TelegramForwardChatFilter;
        forwardChatImportantPatterns?: string[];
      } = {
        botToken: next.botToken,
        chatId: next.chatId,
      };
      if (!userEmpty) persisted.user = next.user;
      if (next.forwardChat !== DEFAULT_FORWARD_CHAT) {
        persisted.forwardChat = next.forwardChat;
      }
      if (next.forwardChatMinChars !== DEFAULT_FORWARD_CHAT_MIN_CHARS) {
        persisted.forwardChatMinChars = next.forwardChatMinChars;
      }
      if (next.notificationLevel !== DEFAULT_NOTIFICATION_LEVEL) {
        persisted.notificationLevel = next.notificationLevel;
      }
      if (next.forwardChatFilter !== DEFAULT_FORWARD_CHAT_FILTER) {
        persisted.forwardChatFilter = next.forwardChatFilter;
      }
      if (!importantPatternsDefault) {
        persisted.forwardChatImportantPatterns = next.forwardChatImportantPatterns;
      }
      (updatedManifest as { telegram?: typeof persisted }).telegram = persisted;
    }
    return updatedManifest;
  });
  return next;
}
