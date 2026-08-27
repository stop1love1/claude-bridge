import { NextResponse, type NextRequest } from "next/server";
import {
  COOKIE_NAME,
  INTERNAL_TOKEN_HEADER,
  constantTimeStringEqual,
  findTrustedDevice,
  loadAuthConfig,
  pruneExpired,
  revokeTrustedDevice,
  verifySession,
} from "@/libs/auth";
import { checkCsrf } from "@/libs/csrf";
import { DEMO_MODE } from "@/libs/demoMode";

export const dynamic = "force-dynamic";

function requireAuth(
  req: NextRequest,
): { denied: NextResponse } | { denied: null; payload: { did?: string } | null } {
  const cfg = loadAuthConfig();
  if (!cfg) return { denied: NextResponse.json({ error: "auth not configured" }, { status: 503 }) };
  const internal = req.headers.get(INTERNAL_TOKEN_HEADER);
  if (constantTimeStringEqual(internal, cfg.internalToken)) {
    return { denied: null, payload: null };
  }
  const token = req.cookies.get(COOKIE_NAME)?.value;
  if (!token) return { denied: NextResponse.json({ error: "unauthorized" }, { status: 401 }) };
  const payload = verifySession(token, cfg.secret);
  if (!payload) return { denied: NextResponse.json({ error: "unauthorized" }, { status: 401 }) };
  if (payload.did && !findTrustedDevice(payload.did)) {
    return { denied: NextResponse.json({ error: "unauthorized" }, { status: 401 }) };
  }
  return { denied: null, payload };
}

export function GET(req: NextRequest) {
  if (DEMO_MODE) {
    return NextResponse.json({ error: "demo mode" }, { status: 503 });
  }
  const auth = requireAuth(req);
  if (auth.denied) return auth.denied;
  const cfg = loadAuthConfig();
  if (!cfg) return NextResponse.json({ devices: [] });
  const live = pruneExpired(cfg.trustedDevices);
  const currentDeviceId = auth.payload?.did ?? null;
  return NextResponse.json({
    currentDeviceId,
    devices: live.map((d) => ({
      id: d.id,
      label: d.label ?? null,
      createdAt: d.createdAt,
      lastSeenAt: d.lastSeenAt,
      expiresAt: d.expiresAt,
      isCurrent: currentDeviceId !== null && d.id === currentDeviceId,
    })),
  });
}

export function DELETE(req: NextRequest) {
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
  const auth = requireAuth(req);
  if (auth.denied) return auth.denied;
  const id = req.nextUrl.searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id query param required" }, { status: 400 });
  if (auth.payload?.did && id === auth.payload.did) {
    return NextResponse.json(
      {
        error: "cannot revoke the current device",
        hint: "use Sign Out to end this session — revoke is for OTHER devices",
      },
      { status: 400 },
    );
  }
  const ok = revokeTrustedDevice(id);
  return NextResponse.json({ ok });
}
