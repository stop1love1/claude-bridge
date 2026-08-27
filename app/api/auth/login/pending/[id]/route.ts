import { NextResponse, type NextRequest } from "next/server";
import {
  COOKIE_NAME,
  SESSION_TTL_MS,
  TRUSTED_TTL_MS,
  addTrustedDevice,
  loadAuthConfig,
  sessionCookieOptions,
  signSession,
} from "@/libs/auth";
import {
  consumePendingLogin,
  getPendingLogin,
} from "@/libs/loginApprovals";
import { getClientIp } from "@/libs/clientIp";
import { DEMO_MODE } from "@/libs/demoMode";
import { checkRateLimit } from "@/libs/rateLimit";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

const PENDING_WINDOW_MS = 60 * 1000;
const PENDING_LIMIT_PER_IP = 30;

export async function GET(req: NextRequest, ctx: Ctx) {
  if (DEMO_MODE) {
    return NextResponse.json({ error: "demo mode" }, { status: 503 });
  }
  const { id } = await ctx.params;
  if (!id) {
    return NextResponse.json({ error: "id required" }, { status: 400 });
  }

  const ip = getClientIp(req.headers);
  const denied = checkRateLimit("auth:pending-poll:ip", ip, PENDING_LIMIT_PER_IP, PENDING_WINDOW_MS);
  if (denied) {
    return NextResponse.json(denied.body, { status: denied.status, headers: denied.headers });
  }

  const cfg = loadAuthConfig();
  if (!cfg) {
    return NextResponse.json(
      { error: "auth not configured" },
      { status: 503 },
    );
  }

  const entry = getPendingLogin(id);
  if (!entry) {
    return NextResponse.json(
      { status: "expired" },
      { status: 410 },
    );
  }

  if (entry.status === "pending") {
    if (entry.expiresAt <= Date.now()) {
      consumePendingLogin(id);
      return NextResponse.json({ status: "expired" }, { status: 410 });
    }
    return NextResponse.json(
      { status: "pending", expiresAt: new Date(entry.expiresAt).toISOString() },
      { status: 202 },
    );
  }

  if (entry.status === "denied") {
    consumePendingLogin(id);
    return NextResponse.json(
      { status: "denied", reason: entry.reason ?? null },
      { status: 403 },
    );
  }

  const uaMatch = (req.headers.get("user-agent") ?? "") === entry.userAgent;
  const ipKnown = ip !== "unknown" && entry.remoteIp !== "unknown";
  const ipMatch = !ipKnown || ip === entry.remoteIp;
  if (!uaMatch || !ipMatch) {
    return NextResponse.json(
      { status: "pending", expiresAt: new Date(entry.expiresAt).toISOString() },
      { status: 202 },
    );
  }

  let deviceId: string | undefined;
  if (entry.trust) {
    const { device } = addTrustedDevice(entry.deviceLabel);
    deviceId = device.id;
  }
  const ttl = entry.trust ? TRUSTED_TTL_MS : SESSION_TTL_MS;
  const exp = Date.now() + ttl;
  const secret = loadAuthConfig()?.secret ?? cfg.secret;
  const token = signSession(
    { sub: entry.email, exp, did: deviceId },
    secret,
  );

  consumePendingLogin(id);

  const res = NextResponse.json({
    status: "approved",
    user: { email: entry.email },
    trusted: entry.trust,
  });
  res.cookies.set(COOKIE_NAME, token, sessionCookieOptions(ttl));
  return res;
}
