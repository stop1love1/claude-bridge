import { NextResponse, type NextRequest } from "next/server";
import {
  COOKIE_NAME,
  INTERNAL_TOKEN_HEADER,
  findTrustedDevice,
  loadAuthConfig,
  touchTrustedDevice,
  verifySession,
} from "@/lib/auth";
import { checkCsrf } from "@/lib/csrf";

// Next.js 16 runs `proxy.ts` on the Node runtime by default, so we no
// longer declare `runtime: "nodejs"` here — Next rejects route-segment
// config in proxy files entirely (build error: "Route segment config
// is not allowed in Proxy file"). Only `matcher` is allowed.
export const config = {
  // Run on every request EXCEPT static assets, the login page, the auth
  // API surface, and Next-internal routes. Note: cannot use lookbehind
  // here — Next.js compiles this matcher into a path regex and rejects
  // some look-around forms. Plain negative-class is safest.
  // Exclude `/` (home) so it stays publicly viewable, plus the
  // bypass list for static + auth routes. We require a non-empty
  // path AFTER the leading slash via `.+` (rather than `.*`) — that
  // single extra `+` is what keeps `/` itself out of the matcher.
  matcher: ["/((?!_next/|favicon\\.ico|logo\\.svg|robots\\.txt|api/auth/|login).+)"],
};

/**
 * The bridge runs as a single-user web app on localhost. Once an
 * operator has set a password (`bun scripts/set-password.ts`), every
 * page + API call is gated behind a signed session cookie unless:
 *
 *   1. Auth isn't configured yet — first-run bootstrap, redirect to
 *      `/login?setup=1` for any HTML route, return 401 for API.
 *   2. The request carries a valid `x-bridge-internal-token` header —
 *      child agents (`agents/permission-hook.cjs`) and the coordinator
 *      template's curl-back commands hit the bridge without a browser
 *      cookie, so they sign with the per-install internal token instead.
 *
 * On a valid cookie we fall through to the route. On an invalid /
 * missing cookie we either redirect to `/login?next=...` (HTML) or
 * 401 (API).
 */
export function proxy(req: NextRequest) {
  const { pathname, search } = req.nextUrl;
  const cfg = loadAuthConfig();

  // CSRF gate runs ahead of the auth check so a hostile cross-origin
  // POST is rejected even when the operator's cookie is valid. GETs
  // and internal-token requests pass through (see lib/csrf.ts for
  // the rationale). The matcher excludes /api/auth/, so /api/auth/login
  // / /api/auth/setup add their own checkCsrf call inline.
  const csrf = checkCsrf(req);
  if (!csrf.ok) {
    if (pathname.startsWith("/api/")) {
      return NextResponse.json(
        { error: "csrf check failed", reason: csrf.reason ?? null },
        { status: 403 },
      );
    }
    return new NextResponse("Forbidden", { status: 403 });
  }

  // First-run: no password set yet. Force every browser request to
  // `/login?setup=1` so the operator sees the setup form. API calls
  // get a 401 with a clear hint.
  if (!cfg) {
    if (pathname.startsWith("/api/")) {
      return NextResponse.json(
        { error: "auth not configured", hint: "run `bun scripts/set-password.ts`" },
        { status: 401 },
      );
    }
    const url = req.nextUrl.clone();
    url.pathname = "/login";
    url.search = "?setup=1";
    return NextResponse.redirect(url);
  }

  // Internal bypass for child agents (loopback only — Next gives us
  // `req.ip` on the server runtime; trust the header only when paired
  // with the per-install random token to avoid header spoofing from
  // the browser).
  const internalToken = req.headers.get(INTERNAL_TOKEN_HEADER);
  if (internalToken && cfg.internalToken && internalToken === cfg.internalToken) {
    return NextResponse.next();
  }

  // Cookie path.
  const token = req.cookies.get(COOKIE_NAME)?.value;
  if (token) {
    const payload = verifySession(token, cfg.secret);
    if (payload) {
      // If the cookie claims a trusted device, the device has to still
      // be in the allowlist — otherwise a "remember me" session is
      // unrevokable. Bump `lastSeenAt` for active devices.
      if (payload.did) {
        if (!findTrustedDevice(payload.did)) {
          return rejectAuth(req, pathname, search);
        }
        try { touchTrustedDevice(payload.did); }
        catch { /* writes to bridge.json are best-effort here */ }
      }
      return NextResponse.next();
    }
  }

  return rejectAuth(req, pathname, search);
}

function rejectAuth(req: NextRequest, pathname: string, search: string): NextResponse {
  if (pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const url = req.nextUrl.clone();
  url.pathname = "/login";
  // Round-trip the attempted URL so we land back on it post-login.
  url.search = `?next=${encodeURIComponent(pathname + (search || ""))}`;
  return NextResponse.redirect(url);
}
