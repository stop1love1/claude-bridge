import { NextResponse } from "next/server";
import {
  getUserClientSelf,
  isUserClientConfigured,
  sendUserMessage,
} from "@/lib/telegramUserClient";

export const dynamic = "force-dynamic";

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
export async function POST() {
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
      { ok: false, reason: (err as Error).message },
      { status: 503 },
    );
  }
}
