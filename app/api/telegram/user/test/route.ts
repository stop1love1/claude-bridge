import { NextResponse, type NextRequest } from "next/server";
import {
  getUserClientSelf,
  isUserClientConfigured,
  sendUserMessage,
} from "@/libs/telegramUserClient";
import { safeErrorMessage } from "@/libs/errorResponse";
import { getClientIp } from "@/libs/clientIp";
import { checkRateLimit } from "@/libs/rateLimit";

export const dynamic = "force-dynamic";

/**
 * Telegram test sends one real message per call via the user-client's
 * outbound MTProto connection. 5/min/IP keeps an authenticated operator
 * from spamming their channel by hammering the "Test" button, and stops
 * a hostile authenticated context from racking up provider cost.
 */
const TELEGRAM_TEST_WINDOW_MS = 60 * 1000;
const TELEGRAM_TEST_LIMIT_PER_IP = 5;

/**
 * POST /api/telegram/user/test
 *
 * Verifies the user-client's StringSession is alive and the configured
 * `targetChatId` is reachable by:
 *   1. Connecting (lazy — first call only)
 *   2. Calling `getMe` to confirm the session is authorized
 *   3. Sending a one-off "✅ Bridge user-client OK" message
 *
 * Returns 200 with the resolved user info on success, 503 with a
 * structured `reason` on any failure so the UI can toast it.
 */
export async function POST(req: NextRequest) {
  const ip = getClientIp(req.headers);
  const denied = checkRateLimit("telegram:test:ip", ip, TELEGRAM_TEST_LIMIT_PER_IP, TELEGRAM_TEST_WINDOW_MS);
  if (denied) {
    return NextResponse.json(denied.body, { status: denied.status, headers: denied.headers });
  }
  if (!isUserClientConfigured()) {
    return NextResponse.json(
      { ok: false, reason: "user-client not configured (run `bun scripts/telegram-login.ts`)" },
      { status: 503 },
    );
  }
  try {
    const me = await getUserClientSelf();
    if (!me) {
      return NextResponse.json(
        { ok: false, reason: "user-client unreachable (session may be revoked)" },
        { status: 503 },
      );
    }
    await sendUserMessage("✅ Claude Bridge → user-client test OK");
    return NextResponse.json({ ok: true, me });
  } catch (err) {
    return NextResponse.json(
      { ok: false, reason: safeErrorMessage(err, "telegram_test_failed") },
      { status: 503 },
    );
  }
}
