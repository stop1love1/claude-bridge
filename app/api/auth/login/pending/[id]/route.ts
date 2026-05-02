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

/**
 * The new device polls this endpoint roughly once per second while the
 * operator decides on the approval. 30/minute/IP keeps the legitimate
 * polling cadence comfortably (typical: 60 polls in 60s but the entry
 * is consumed on terminal status, so real usage averages well below).
 * The cap mostly stops a hostile client from enumerating valid pending
 * IDs — pending IDs are random UUIDs, but rate-limiting still raises
 * the cost of any future ID-shape weakening.
 */
const PENDING_WINDOW_MS = 60 * 1000;
const PENDING_LIMIT_PER_IP = 30;

/**
 * GET /api/auth/login/pending/[id]
 *
 * The new device polls this URL after `POST /api/auth/login` returned
 * `202 { status: "pending", pendingId }`. We return one of:
 *
 *   - 202 `{ status: "pending" }`        — still waiting on the operator
 *   - 200 `{ status: "approved" }`       — operator approved; the cookie
 *                                          is set on THIS response so the
 *                                          new device is logged in by
 *                                          the time it redirects.
 *   - 403 `{ status: "denied", reason }` — operator denied
 *   - 410 `{ status: "expired" }`        — the 3-min window passed
 *
 * Each terminal state is delivered exactly once; we `consumePendingLogin`
 * after delivery so a stale poll can't replay a stale approval. The new
 * device is expected to stop polling on any non-202 response.
 */
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

  // Approved — sign the cookie + (optionally) record a trusted device
  // entry, mirroring the post-credentials path of /api/auth/login.
  let deviceId: string | undefined;
  if (entry.trust) {
    const { device } = addTrustedDevice(entry.deviceLabel);
    deviceId = device.id;
  }
  const ttl = entry.trust ? TRUSTED_TTL_MS : SESSION_TTL_MS;
  const exp = Date.now() + ttl;
  // Re-load the secret in case `addTrustedDevice` re-read the file.
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
