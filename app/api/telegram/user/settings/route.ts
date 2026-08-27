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
  await disconnectTelegramUserClient().catch(() => { });
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

export async function DELETE() {
  setManifestTelegramSettings({
    user: { apiId: 0, apiHash: "", session: "", targetChatId: "" },
  });
  await disconnectTelegramUserClient().catch(() => { });
  teardownTelegramNotifier();
  ensureTelegramNotifier();
  return NextResponse.json({ ok: true });
}

function maskShort(s: string): string {
  if (s.length <= 4) return "•".repeat(s.length);
  return `${"•".repeat(Math.min(s.length - 4, 28))}${s.slice(-4)}`;
}

function maskLong(s: string): string {
  if (s.length <= 8) return "•".repeat(s.length);
  return `${"•".repeat(20)}${s.slice(-6)} (${s.length} chars)`;
}
