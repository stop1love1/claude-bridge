import { NextResponse, type NextRequest } from "next/server";
import {
  COOKIE_NAME,
  loadAuthConfig,
  revokeTrustedDevice,
  verifySession,
} from "@/lib/auth";

export const dynamic = "force-dynamic";

/**
 * POST /api/auth/logout
 *
 * Clears the `bridge_session` cookie. If the cookie was tied to a
 * trusted device (`payload.did`) we also remove that entry from the
 * server-side allowlist so the long-lived cookie cannot be reused
 * even if it leaked. Always returns `{ ok: true }` — logging out is
 * idempotent.
 */
export function POST(req: NextRequest) {
  const cfg = loadAuthConfig();
  const token = req.cookies.get(COOKIE_NAME)?.value;
  if (token && cfg) {
    const payload = verifySession(token, cfg.secret);
    if (payload?.did) {
      try { revokeTrustedDevice(payload.did); }
      catch { /* best-effort */ }
    }
  }
  const res = NextResponse.json({ ok: true });
  res.cookies.set(COOKIE_NAME, "", {
    httpOnly: true,
    sameSite: "lax",
    secure: false,
    path: "/",
    maxAge: 0,
  });
  return res;
}
