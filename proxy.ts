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

const DEMO_REDIRECT_PREFIXES = [
  "/apps",
  "/tasks",
  "/sessions",
  "/settings",
  "/tunnels",
];

export const config = {
  matcher: ["/((?!_next/|favicon\\.ico|logo\\.svg|robots\\.txt|sw\\.js$|manifest\\.webmanifest$|icon\\.svg$|api/auth/|api/share/access/|share/|login|docs).+)"],
};

export function proxy(req: NextRequest) {
  const { pathname, search } = req.nextUrl;

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
    return NextResponse.next();
  }

  const cfg = loadAuthConfig();

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

  const token = req.cookies.get(COOKIE_NAME)?.value;
  if (token) {
    const payload = verifySession(token, cfg.secret);
    if (payload) {
      if (payload.kind === "guest") {
        return authorizeGuest(req, payload, pathname, search);
      }
      if (payload.did) {
        if (!findTrustedDevice(payload.did)) {
          return rejectAuth(req, pathname, search);
        }
        try { touchTrustedDevice(payload.did); }
        catch { }
      }
      return NextResponse.next();
    }
  }

  return rejectAuth(req, pathname, search);
}

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
  url.search = `?next=${encodeURIComponent(pathname + (search || ""))}`;
  return NextResponse.redirect(url);
}
