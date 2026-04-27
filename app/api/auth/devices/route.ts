import { NextResponse, type NextRequest } from "next/server";
import {
  COOKIE_NAME,
  INTERNAL_TOKEN_HEADER,
  findTrustedDevice,
  loadAuthConfig,
  pruneExpired,
  revokeTrustedDevice,
  verifySession,
} from "@/lib/auth";

export const dynamic = "force-dynamic";

/**
 * Devices is the one route under `/api/auth/` that's NOT public — the
 * middleware whitelists everything below `/api/auth/` so login + me +
 * logout work without a cookie, so this handler does its own auth
 * check instead. Bridge-internal callers (child agents) get a pass via
 * the same `x-bridge-internal-token` header the middleware accepts.
 *
 * Returns either an early-return error response, or the current
 * cookie's session payload when one is present (DELETE uses
 * `payload.did` to refuse self-revocation — the operator can't
 * accidentally lock themselves out of the very tab they're on).
 * Internal-token callers get `{ payload: null }` since they aren't
 * tied to a trusted device.
 */
function requireAuth(
  req: NextRequest,
): { denied: NextResponse } | { denied: null; payload: { did?: string } | null } {
  const cfg = loadAuthConfig();
  if (!cfg) return { denied: NextResponse.json({ error: "auth not configured" }, { status: 503 }) };
  const internal = req.headers.get(INTERNAL_TOKEN_HEADER);
  if (internal && cfg.internalToken && internal === cfg.internalToken) {
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

/**
 * GET /api/auth/devices
 *
 * Lists every active trusted-device entry — used by the Settings page
 * so the operator can see which browsers have a long-lived "remember
 * me" cookie and revoke any that shouldn't (lost laptop, shared box).
 *
 * DELETE /api/auth/devices?id=<dev_xxx>
 *
 * Removes a single device from the allowlist. The cookie itself stays
 * valid HMAC-wise, but middleware re-checks the device every request,
 * so the next page load on that device will redirect to /login.
 */
export function GET(req: NextRequest) {
  const auth = requireAuth(req);
  if (auth.denied) return auth.denied;
  const cfg = loadAuthConfig();
  if (!cfg) return NextResponse.json({ devices: [] });
  const live = pruneExpired(cfg.trustedDevices);
  // Tag the requesting cookie's own device id so the UI can mark it
  // "This device" and disable the revoke button — accidentally
  // revoking the very tab you're on triggers a reload loop the moment
  // proxy.ts re-checks `findTrustedDevice` on the next request.
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
  const auth = requireAuth(req);
  if (auth.denied) return auth.denied;
  const id = req.nextUrl.searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id query param required" }, { status: 400 });
  // Self-revoke guard: if the caller is revoking their OWN device we
  // refuse — without this the next page load on this device would
  // bounce to /login (proxy re-checks the device on every request),
  // and combined with `/api/auth/me` returning user info even when
  // the device is gone, the operator's tab would loop /login → /
  // → /login → / forever. Operator must use Sign Out for self.
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
