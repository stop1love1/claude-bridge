import { NextResponse } from "next/server";
import { ensureTelegramNotifier, pingTelegramTest } from "@/lib/telegramNotifier";

export const dynamic = "force-dynamic";

/**
 * POST /api/telegram/test
 *
 * Sends a one-off "✅ Claude Bridge → Telegram test OK" message to the
 * configured chat so the user can verify their bot token + chat id
 * without having to wait for an agent to finish.
 *
 * Returns:
 *   200 { ok: true }                       — message delivered
 *   503 { ok: false, reason: "..." }       — env not configured / send failed
 *
 * The route also re-runs `ensureTelegramNotifier()` so a hot edit to
 * the env (after a process restart) lights the subscription up without
 * needing the user to restart the dev server twice.
 */
export async function POST() {
  ensureTelegramNotifier();
  const r = await pingTelegramTest();
  if (!r.ok) {
    return NextResponse.json({ ok: false, reason: r.reason ?? "unknown" }, { status: 503 });
  }
  return NextResponse.json({ ok: true });
}
