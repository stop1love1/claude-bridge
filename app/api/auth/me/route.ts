import { NextResponse, type NextRequest } from "next/server";
import {
  COOKIE_NAME,
  findTrustedDevice,
  loadAuthConfig,
  verifySession,
} from "@/libs/auth";
import { DEMO_MODE } from "@/libs/demoMode";

export const dynamic = "force-dynamic";

export function GET(req: NextRequest) {
  if (DEMO_MODE) {
    return NextResponse.json({ error: "demo mode" }, { status: 503 });
  }
  const cfg = loadAuthConfig();
  if (!cfg) return NextResponse.json({ configured: false }, { status: 200 });
  const token = req.cookies.get(COOKIE_NAME)?.value;
  if (!token) return NextResponse.json({ configured: true, user: null });
  const payload = verifySession(token, cfg.secret);
  if (!payload) return NextResponse.json({ configured: true, user: null });
  if (payload.did && !findTrustedDevice(payload.did)) {
    return NextResponse.json({ configured: true, user: null });
  }
  const device = payload.did ? findTrustedDevice(payload.did) : null;
  return NextResponse.json({
    configured: true,
    user: { email: payload.sub },
    trustedDevice: device
      ? {
          id: device.id,
          label: device.label ?? null,
          createdAt: device.createdAt,
          expiresAt: device.expiresAt,
        }
      : null,
    expiresAt: new Date(payload.exp).toISOString(),
  });
}
