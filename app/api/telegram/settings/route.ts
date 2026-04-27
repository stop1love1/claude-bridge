import { NextResponse, type NextRequest } from "next/server";
import {
  getManifestTelegramSettings,
  setManifestTelegramSettings,
  type TelegramForwardChat,
} from "@/lib/apps";
import {
  ensureTelegramNotifier,
  teardownTelegramNotifier,
} from "@/lib/telegramNotifier";

export const dynamic = "force-dynamic";

interface TelegramSettingsPatchBody {
  botToken?: string;
  chatId?: string;
  forwardChat?: TelegramForwardChat;
  forwardChatMinChars?: number;
}

/**
 * GET /api/telegram/settings
 *
 * Returns the active Telegram credentials. The bot token is masked in
 * the response so it doesn't leak into browser DevTools / network logs;
 * the UI just needs to know whether one is set, not its contents.
 */
export function GET() {
  const settings = getManifestTelegramSettings();
  return NextResponse.json({
    botToken: settings.botToken ? maskToken(settings.botToken) : "",
    botTokenSet: settings.botToken.length > 0,
    chatId: settings.chatId,
    forwardChat: settings.forwardChat,
    forwardChatMinChars: settings.forwardChatMinChars,
  });
}

/**
 * PUT /api/telegram/settings
 *
 * Body: `{ botToken?, chatId?, forwardChat?, forwardChatMinChars? }`.
 * Empty strings clear the corresponding field; omitted fields are left
 * as-is. Once both fields are empty (and forwardChat is at default) the
 * entire `telegram` section is dropped from `bridge.json` (handled by
 * `setManifestTelegramSettings`).
 *
 * Returns the post-write settings (bot token masked).
 */
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

  const next = setManifestTelegramSettings(patch);

  // Install (or re-install) the notifier subscription right now —
  // without this the operator has to restart `bun dev` for new
  // credentials to take effect, since `instrumentation.ts` only runs
  // once per server boot. Tear down first so a token / chat id swap
  // doesn't leave the old subscribers attached.
  if (next.botToken && next.chatId) {
    teardownTelegramNotifier();
    ensureTelegramNotifier();
  } else {
    // Cleared both fields → unsubscribe so we don't leave dead
    // listeners feeding `sendTelegram` (which would short-circuit on
    // missing creds anyway, but the channel cost is wasteful).
    teardownTelegramNotifier();
  }

  return NextResponse.json({
    botToken: next.botToken ? maskToken(next.botToken) : "",
    botTokenSet: next.botToken.length > 0,
    chatId: next.chatId,
    forwardChat: next.forwardChat,
    forwardChatMinChars: next.forwardChatMinChars,
  });
}

/**
 * Show the last 4 chars of the token, masking the rest with `•`. Bot
 * tokens are sensitive (anyone holding one can post as the bot) — we
 * never echo the full string back to a UI.
 */
function maskToken(token: string): string {
  if (token.length <= 4) return "•".repeat(token.length);
  return `${"•".repeat(token.length - 4)}${token.slice(-4)}`;
}
