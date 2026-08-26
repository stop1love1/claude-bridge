import { NextResponse, type NextRequest } from "next/server";
import {
  COOKIE_NAME,
  INTERNAL_TOKEN_HEADER,
  findTrustedDevice,
  loadAuthConfig,
  touchTrustedDevice,
  verifySession,
  type SessionPayload,
} from "@/libs/auth";
import { checkCsrf } from "@/libs/csrf";
import { DEMO_MODE } from "@/libs/demoMode";
import { findValidDevice, getShare, isShareUsable } from "@/libs/shareStore";
import { authorizeGuestRequest, sessionBelongsToTask } from "@/libs/guestAccess";
import { CLIENT_FORWARDED_FOR_HEADER, PEER_ADDR_HEADER } from "@/libs/peerAddr";
import { evaluateInternalTokenGate } from "@/libs/internalTokenGate";

/**
 * Paths the demo-mode gate redirects to `/`. Anything here is part of
 * the operator dashboard (apps registry, task board, raw sessions,
 * settings) and has no meaningful behavior when the bridge can't run
 * agents — so we send the visitor back to the showcase landing page.
 *
 * `/login` is intentionally NOT in this list because the matcher
 * below excludes it (excluding it avoids redirect loops in normal
 * mode — the proxy redirects unauth'd users TO `/login`). The demo
 * redirect for `/login` lives in `app/login/layout.tsx` instead.
 */
const DEMO_REDIRECT_PREFIXES = [
  "/apps",
  "/tasks",
  "/sessions",
  "/settings",
  "/tunnels",
];

// Next.js 16 runs `proxy.ts` on the Node runtime by default, so we no
// longer declare `runtime: "nodejs"` here — Next rejects route-segment
// config in proxy files entirely (build error: "Route segment config
// is not allowed in Proxy file"). Only `matcher` is allowed.
export const config = {
  // Run on every request EXCEPT static assets, the login page, the auth
  // API surface, the public `/docs` page, and Next-internal routes.
  // Note: cannot use lookbehind here — Next.js compiles this matcher
  // into a path regex and rejects some look-around forms. Plain
  // negative-class is safest.
  // Exclude `/` (home) so it stays publicly viewable, plus the
  // bypass list for static + auth routes + the docs page. We require
  // a non-empty path AFTER the leading slash via `.+` (rather than
  // `.*`) — that single extra `+` is what keeps `/` itself out of
  // the matcher.
  // `share/` (the public guest landing page) and `api/share/access/`
  // (the public guest request/poll endpoints) are excluded so a guest
  // with no cookie can reach them — same rationale as `/login` +
  // `/api/auth/`. The OPERATOR share API (`/api/share`, `/api/share/
  // requests/...`) is deliberately NOT excluded, so it stays cookie-
  // gated. Gated guest DATA routes (`/api/tasks/<tid>/...`) also stay in
  // the matcher so the guest branch below authorizes them per-share.
  //
  // `sw.js` (Task 9's push-notification service worker),
  // `manifest.webmanifest`, and `icon.svg` are excluded too, alongside
  // the other static assets: `authorizeGuest` below denies any non-
  // `/api/` path outright (`splitApiPath` returns null), so a guest's
  // otherwise-valid session cookie would still get a 302-to-`/login`
  // HTML page back for `GET /sw.js` instead of the script — breaking
  // `navigator.serviceWorker.register("/sw.js")` for every guest.
  // Worse, browsers fetch `manifest.webmanifest` (and the icon it/the
  // service worker reference) in credentials-mode `omit` — no cookie
  // is ever sent, so on ANY password-configured bridge those requests
  // always 302 to `/login` and PWA install silently fails, operator or
  // guest alike. None of the three files has sensitive content, so
  // letting them through unauthenticated is safe. The `$` anchor on
  // each is load-bearing: without it any path merely *starting* with
  // e.g. `/sw.js` (`/sw.jsx`, `/sw.js-evil`) would bypass auth too —
  // this matcher is a security boundary, so exclude exactly these paths.
  matcher: ["/((?!_next/|favicon\\.ico|logo\\.svg|robots\\.txt|sw\\.js$|manifest\\.webmanifest$|icon\\.svg$|api/auth/|api/share/access/|share/|login|docs).+)"],
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

  // Demo-mode gate runs first — it's a deployment-shape switch, not
  // a per-request decision. When the bridge is deployed somewhere
  // that can't run agents (Vercel / serverless / no persistent FS),
  // `BRIDGE_DEMO_MODE=1` blanks the dashboard entirely:
  //   - protected page paths → 302 to `/` (the landing showcase)
  //   - non-public /api/* paths → 503 JSON
  // CSRF / auth never get to run; the rest of the bridge logic doesn't
  // matter when the backend can't function.
  if (DEMO_MODE) {
    const blocked = DEMO_REDIRECT_PREFIXES.some(
      (p) => pathname === p || pathname.startsWith(`${p}/`),
    );
    if (blocked) {
      const url = req.nextUrl.clone();
      url.pathname = "/";
      url.search = "";
      return NextResponse.redirect(url);
    }
    if (pathname.startsWith("/api/")) {
      return NextResponse.json(
        {
          error: "demo mode",
          hint: "this deployment runs the bridge UI without agent backends; clone the repo locally to use the dashboard",
        },
        { status: 503 },
      );
    }
    // Public paths (`/`, `/docs`, static, `/api/auth/*` excluded by
    // matcher) fall through to the route. The auth APIs return 401
    // safely on demo deployments because no auth config exists.
    return NextResponse.next();
  }

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

  // Internal bypass for child agents. The token is a per-install secret
  // shared only with locally-spawned children (`agents/permission-hook.cjs`,
  // coordinator curl-backs) connecting to `localhost:<port>` directly.
  // The actual gate decision lives in `libs/internalTokenGate.ts` (pure,
  // unit-tested — see `libs/__tests__/internalTokenGate.test.ts`) so
  // this file only has to marshal headers into it. Three same-host
  // signals feed the gate (full algebra + rationale for each is in that
  // file's doc comments — this is the short version):
  //   1. The TCP peer address, NOT the `Host` header. The header is
  //      client-supplied — a non-browser caller can send
  //      `Host: localhost` with no forwarding headers and forge "same
  //      host" to unlock this bypass on every route. `libs/setupToken.ts`
  //      documents this exact attack against `/api/auth/setup`, which
  //      was migrated off Host-based checks for the same reason; this
  //      check hadn't been (audit H2). `scripts/bridge-http-server.ts`
  //      stamps the real `req.socket.remoteAddress` onto
  //      `PEER_ADDR_HEADER` before handing the request to Next —
  //      deleting any inbound copy first, so it can't be forged either.
  //   2. Genuine proxy-chain headers. `x-real-ip` and RFC 7239
  //      `forwarded` are read straight off the request — Next doesn't
  //      touch either. `x-forwarded-for` is NOT read directly: Next's
  //      `base-server.js` unconditionally runs `req.headers['x-forwarded-
  //      for'] ??= req.socket.remoteAddress` on every request it
  //      handles, so by the time middleware runs, that header is
  //      present on 100% of requests — including a direct same-host
  //      call with no proxy anywhere in the picture. Reading it
  //      directly would make `viaProxy` unconditionally true and kill
  //      the bypass for every legitimate child (this shipped broken —
  //      see the header comment on `CLIENT_FORWARDED_FOR_HEADER` in
  //      `libs/peerAddr.ts`). Instead we read `CLIENT_FORWARDED_FOR_
  //      HEADER`, which `bridge-http-server.ts` stamps from the
  //      client's OWN `x-forwarded-for` before Next's default-fill can
  //      run. `x-forwarded-host` is never read here either, for the
  //      same reason — Next injects it on direct local requests too,
  //      so it can't distinguish a real proxy from a same-process
  //      request; this bug is that exact trap on a header nobody had
  //      checked for it yet.
  //   3. `Host`, as an ADDITIONAL OR-ed restriction (never a
  //      replacement for #1 — see `isExpectedLocalHost`'s doc comment
  //      in `libs/internalTokenGate.ts`). `libs/tunnels.ts` spawns
  //      localtunnel/ngrok on the SAME machine as the bridge, so a
  //      request through the operator's own public tunnel has a
  //      LOOPBACK peer — signal #1 alone can't distinguish that from a
  //      direct local call, and whether signal #2 catches it depends on
  //      the tunnel provider's undocumented header behavior. The tunnel
  //      DOES forward the public hostname as `Host`, so this closes
  //      that gap without reopening H2: adding a term to an OR only
  //      makes `viaProxy` MORE often true, so a `Host` spoof (an
  //      attacker's only lever here) can decline to add a restriction
  //      but can never remove one — #1 alone still gates every case
  //      H2 exploited.
  const internalToken = req.headers.get(INTERNAL_TOKEN_HEADER);
  const bypass = evaluateInternalTokenGate({
    peerAddr: req.headers.get(PEER_ADDR_HEADER),
    clientForwardedFor: req.headers.get(CLIENT_FORWARDED_FOR_HEADER),
    xRealIp: req.headers.get("x-real-ip"),
    forwarded: req.headers.get("forwarded"),
    hostHeader: req.headers.get("host"),
    expectedBridgeHost: process.env.BRIDGE_HOST ?? null,
    internalToken,
    configuredInternalToken: cfg.internalToken,
  });
  if (bypass) {
    return NextResponse.next();
  }

  // Cookie path.
  const token = req.cookies.get(COOKIE_NAME)?.value;
  if (token) {
    const payload = verifySession(token, cfg.secret);
    if (payload) {
      // Guest (task-share) cookie: authorize against the LIVE share —
      // never the cookie's stale claims — so revoke / expiry / grant
      // edits take effect instantly. Deny-by-default: a guest is only
      // allowed the per-share allowlist of API routes bound to its task.
      if (payload.kind === "guest") {
        return authorizeGuest(req, payload, pathname, search);
      }
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

/**
 * Authorize a task-share guest. Validates the cookie's share + device
 * against the LIVE store (instant revoke/expiry), then applies the
 * deny-by-default allowlist bound to the share's task. Guests only ever
 * touch the gated API; a guest who navigates to a dashboard page is
 * bounced to login like any unauthenticated visitor.
 */
function authorizeGuest(
  req: NextRequest,
  payload: SessionPayload,
  pathname: string,
  search: string,
): NextResponse {
  const { sid, tid, did } = payload;
  const share = sid ? getShare(sid) : null;
  if (
    !share ||
    !isShareUsable(share) ||
    !tid ||
    share.taskId !== tid ||
    !did ||
    !findValidDevice(share, did)
  ) {
    return rejectAuth(req, pathname, search);
  }
  const decision = authorizeGuestRequest(
    req.method,
    pathname,
    { taskId: share.taskId, grants: share.grants },
    (s) => sessionBelongsToTask(share.taskId, s),
  );
  if (decision.ok) return NextResponse.next();
  if (pathname.startsWith("/api/")) {
    return NextResponse.json(
      { error: "forbidden", reason: decision.reason ?? null },
      { status: 403 },
    );
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
