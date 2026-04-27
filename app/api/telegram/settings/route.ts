import { NextResponse, type NextRequest } from "next/server";
import {
  getManifestTelegramSettings,
  setManifestTelegramSettings,
  type TelegramSettings,
} from "@/lib/apps";
import {
  ensureTelegramNotifier,
  teardownTelegramNotifier,
} from "@/lib/telegramNotifier";

export const dynamic = "force-dynamic";

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
  });
}

/**
 * PUT /api/telegram/settings
 *
 * Body: `{ botToken?: string, chatId?: string }`. Empty strings clear
 * the corresponding field; omitted fields are left as-is. Once both
 * fields are empty the entire `telegram` section is dropped from
 * `bridge.json` (set by `setManifestTelegramSettings`).
 *
 * Returns the post-write settings (bot token masked).
 */
export async function PUT(req: NextRequest) {
  let body: Partial<TelegramSettings>;
  try {
    body = (await req.json()) as Partial<TelegramSettings>;
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const patch: Partial<TelegramSettings> = {};
  if (typeof body.botToken === "string") patch.botToken = body.botToken;
  if (typeof body.chatId === "string") patch.chatId = body.chatId;

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
