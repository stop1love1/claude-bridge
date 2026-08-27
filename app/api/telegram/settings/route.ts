import { NextResponse, type NextRequest } from "next/server";
import {
  getManifestTelegramSettings,
  setManifestTelegramSettings,
  type TelegramForwardChat,
  type TelegramForwardChatFilter,
  type TelegramNotificationLevel,
} from "@/libs/apps";
import {
  ensureTelegramNotifier,
  teardownTelegramNotifier,
} from "@/libs/telegramNotifier";

export const dynamic = "force-dynamic";

interface TelegramSettingsPatchBody {
  botToken?: string;
  chatId?: string;
  forwardChat?: TelegramForwardChat;
  forwardChatMinChars?: number;
  notificationLevel?: TelegramNotificationLevel;
  forwardChatFilter?: TelegramForwardChatFilter;
}

export function GET() {
  const settings = getManifestTelegramSettings();
  return NextResponse.json({
    botToken: settings.botToken ? maskToken(settings.botToken) : "",
    botTokenSet: settings.botToken.length > 0,
    chatId: settings.chatId,
    forwardChat: settings.forwardChat,
    forwardChatMinChars: settings.forwardChatMinChars,
    notificationLevel: settings.notificationLevel,
    forwardChatFilter: settings.forwardChatFilter,
  });
}

export async function PUT(req: NextRequest) {
  let body: TelegramSettingsPatchBody;
  try {
    body = (await req.json()) as TelegramSettingsPatchBody;
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const patch: TelegramSettingsPatchBody = {};
  if (typeof body.botToken === "string") patch.botToken = body.botToken;
  if (typeof body.chatId === "string") patch.chatId = body.chatId;
  if (
    body.forwardChat === "off" ||
    body.forwardChat === "coordinator-only" ||
    body.forwardChat === "all"
  ) {
    patch.forwardChat = body.forwardChat;
  }
  if (typeof body.forwardChatMinChars === "number") {
    patch.forwardChatMinChars = body.forwardChatMinChars;
  }
  if (
    body.notificationLevel === "minimal" ||
    body.notificationLevel === "normal" ||
    body.notificationLevel === "verbose"
  ) {
    patch.notificationLevel = body.notificationLevel;
  }
  if (
    body.forwardChatFilter === "important-only" ||
    body.forwardChatFilter === "all"
  ) {
    patch.forwardChatFilter = body.forwardChatFilter;
  }

  const next = setManifestTelegramSettings(patch);

  if (next.botToken && next.chatId) {
    teardownTelegramNotifier();
    ensureTelegramNotifier();
  } else {
    teardownTelegramNotifier();
  }

  return NextResponse.json({
    botToken: next.botToken ? maskToken(next.botToken) : "",
    botTokenSet: next.botToken.length > 0,
    chatId: next.chatId,
    forwardChat: next.forwardChat,
    forwardChatMinChars: next.forwardChatMinChars,
    notificationLevel: next.notificationLevel,
    forwardChatFilter: next.forwardChatFilter,
  });
}

function maskToken(token: string): string {
  if (token.length <= 4) return "•".repeat(token.length);
  return `${"•".repeat(token.length - 4)}${token.slice(-4)}`;
}
