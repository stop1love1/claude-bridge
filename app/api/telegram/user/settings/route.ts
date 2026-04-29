import { NextResponse, type NextRequest } from "next/server";
import {
  getManifestTelegramSettings,
  setManifestTelegramSettings,
  type TelegramUserSettings,
} from "@/libs/apps";
import { disconnectTelegramUserClient } from "@/libs/telegramUserClient";
import {
  ensureTelegramNotifier,
  teardownTelegramNotifier,
} from "@/libs/telegramNotifier";

export const dynamic = "force-dynamic";

/**
 * GET /api/telegram/user/settings
 *
 * Returns the active Telegram user-client settings. apiHash + session
 * are masked so they don't leak via DevTools / network logs — the UI
 * just needs to know whether each is set, not its contents.
 */
export function GET() {
  const s = getManifestTelegramSettings().user;
  return NextResponse.json({
    apiId: s.apiId,
    apiHash: s.apiHash ? maskShort(s.apiHash) : "",
    apiHashSet: s.apiHash.length > 0,
    session: s.session ? maskLong(s.session) : "",
    sessionSet: s.session.length > 0,
    targetChatId: s.targetChatId,
  });
}

/**
 * PUT /api/telegram/user/settings
 *
 * Body: `Partial<TelegramUserSettings>`. Empty strings clear the
 * matching field; omitted fields keep their current value. After write
 * we drop the cached gram-js connection so the next request picks up
 * the new credentials.
 */
export async function PUT(req: NextRequest) {
  let body: Partial<TelegramUserSettings>;
  try {
    body = (await req.json()) as Partial<TelegramUserSettings>;
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const patch: Partial<TelegramUserSettings> = {};
  if (typeof body.apiId === "number") patch.apiId = body.apiId;
  if (typeof body.apiHash === "string") patch.apiHash = body.apiHash;
  if (typeof body.session === "string") patch.session = body.session;
  if (typeof body.targetChatId === "string") patch.targetChatId = body.targetChatId;

  setManifestTelegramSettings({ user: patch });
  // Drop the cached client + bounce the notifier so the new creds are
  // picked up immediately (otherwise the operator has to restart `bun
  // dev` for inbound + outbound user-client wiring to attach).
  await disconnectTelegramUserClient().catch(() => { /* ignore */ });
  teardownTelegramNotifier();
  ensureTelegramNotifier();

  const next = getManifestTelegramSettings().user;
  return NextResponse.json({
    apiId: next.apiId,
    apiHash: next.apiHash ? maskShort(next.apiHash) : "",
    apiHashSet: next.apiHash.length > 0,
    session: next.session ? maskLong(next.session) : "",
    sessionSet: next.session.length > 0,
    targetChatId: next.targetChatId,
  });
}

/**
 * DELETE /api/telegram/user/settings
 *
 * Clear ALL user-client fields and drop the cached connection. The
 * Bot API channel is unaffected.
 */
export async function DELETE() {
  setManifestTelegramSettings({
    user: { apiId: 0, apiHash: "", session: "", targetChatId: "" },
  });
  await disconnectTelegramUserClient().catch(() => { /* ignore */ });
  // Bounce the notifier so the now-empty user creds drop the inbound
  // listener; the bot side (if configured) keeps running.
  teardownTelegramNotifier();
  ensureTelegramNotifier();
  return NextResponse.json({ ok: true });
}

/** Show last 4 chars; mask the rest with `•`. */
function maskShort(s: string): string {
  if (s.length <= 4) return "•".repeat(s.length);
  return `${"•".repeat(Math.min(s.length - 4, 28))}${s.slice(-4)}`;
}

/**
 * Like maskShort but caps the bullet count so a 500-char session
 * string doesn't render as an absurd dot wall in the UI.
 */
function maskLong(s: string): string {
  if (s.length <= 8) return "•".repeat(s.length);
  return `${"•".repeat(20)}${s.slice(-6)} (${s.length} chars)`;
}
