import { NextResponse, type NextRequest } from "next/server";
import {
  COOKIE_NAME,
  findTrustedDevice,
  loadAuthConfig,
  verifySession,
} from "@/libs/auth";

export const dynamic = "force-dynamic";

/**
 * GET /api/auth/me
 *
 * Returns the current logged-in user. Used by the UI to decide whether
 * to show a logout button + the trusted-device label, and by the login
 * page to redirect away if the operator is already authed.
 *
 * Note: middleware also gates this route, so an unauthenticated caller
 * gets a 401 without ever hitting the handler.
 */
export function GET(req: NextRequest) {
  const cfg = loadAuthConfig();
  if (!cfg) return NextResponse.json({ configured: false }, { status: 200 });
  const token = req.cookies.get(COOKIE_NAME)?.value;
  if (!token) return NextResponse.json({ configured: true, user: null });
  const payload = verifySession(token, cfg.secret);
  if (!payload) return NextResponse.json({ configured: true, user: null });
  // If the cookie carries a `did`, it MUST still be in the trusted-
  // device allowlist. A revoked device that retains the cookie would
  // otherwise be reported as "logged in" here while proxy.ts treats
  // the same request as unauthenticated — `/login` then auto-redirects
  // to `/`, proxy bounces back to `/login`, infinite reload loop.
  // Treat the revoked case as logged-out so the login page renders
  // its form instead.
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
