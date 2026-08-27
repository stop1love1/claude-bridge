import { NextResponse } from "next/server";
import { ensureTelegramNotifier, pingTelegramTest } from "@/libs/telegramNotifier";

export const dynamic = "force-dynamic";

export async function POST() {
  ensureTelegramNotifier();
  const r = await pingTelegramTest();
  if (!r.ok) {
    return NextResponse.json({ ok: false, reason: r.reason ?? "unknown" }, { status: 503 });
  }
  return NextResponse.json({ ok: true });
}
