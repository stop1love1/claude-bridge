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

const TELEGRAM_TEST_WINDOW_MS = 60 * 1000;
const TELEGRAM_TEST_LIMIT_PER_IP = 5;

export async function POST(req: NextRequest) {
  const ip = getClientIp(req.headers);
  const denied = checkRateLimit("telegram:test:ip", ip, TELEGRAM_TEST_LIMIT_PER_IP, TELEGRAM_TEST_WINDOW_MS);
  if (denied) {
    return NextResponse.json(denied.body, { status: denied.status, headers: denied.headers });
  }
  if (!isUserClientConfigured()) {
    return NextResponse.json(
      { ok: false, reason: "user-client not configured (run `npm run telegram:login`)" },
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
