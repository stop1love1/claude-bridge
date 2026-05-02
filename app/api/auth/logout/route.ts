import { NextResponse, type NextRequest } from "next/server";
import {
  COOKIE_NAME,
  loadAuthConfig,
  revokeTrustedDevice,
  sessionCookieOptions,
  verifySession,
} from "@/libs/auth";
import { checkCsrf } from "@/libs/csrf";
import { DEMO_MODE } from "@/libs/demoMode";

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
  if (DEMO_MODE) {
    return NextResponse.json({ error: "demo mode" }, { status: 503 });
  }
  const csrf = checkCsrf(req);
  if (!csrf.ok) {
    return NextResponse.json(
      { error: "csrf check failed", reason: csrf.reason ?? null },
      { status: 403 },
    );
  }
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
  // maxAge: 0 ⇒ immediate clear. Reuse the same secure/sameSite/path
  // attributes the cookie was set with so browsers actually drop it.
  res.cookies.set(COOKIE_NAME, "", sessionCookieOptions(0));
  return res;
}
