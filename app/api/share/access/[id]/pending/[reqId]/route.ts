import { NextResponse, type NextRequest } from "next/server";
import { DEMO_MODE } from "@/libs/demoMode";
import { COOKIE_NAME, sessionCookieOptions, signGuestSession } from "@/libs/auth";
import { consumeShareRequest, getShareRequest } from "@/libs/shareApprovals";
import { findValidDevice, getShare, isShareUsable } from "@/libs/shareStore";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string; reqId: string }> };

/**
 * GET /api/share/access/<id>/pending/<reqId>
 *
 * Public guest poll. While pending, returns `{ status: "pending" }`.
 * On approval, **sets the scoped guest cookie** and returns
 * `{ status: "approved", taskId }`, then consumes the request. On denial,
 * returns `{ status: "denied", reason? }` and consumes it.
 */
export async function GET(_req: NextRequest, ctx: Ctx) {
  if (DEMO_MODE) {
    return NextResponse.json({ error: "demo mode" }, { status: 503 });
  }
  const { id, reqId } = await ctx.params;
  const pending = getShareRequest(reqId);
  // Bind the poll to the share in the URL so a leaked reqId can't be
  // polled against the wrong share.
  if (!pending || pending.shareId !== id) {
    return NextResponse.json({ status: "expired" });
  }

  if (pending.status === "pending") {
    return NextResponse.json({ status: "pending" });
  }

  if (pending.status === "denied") {
    const reason = pending.reason ?? null;
    consumeShareRequest(reqId);
    return NextResponse.json({ status: "denied", reason });
  }

  // approved → mint the cookie if the share + device are still valid.
  const share = getShare(pending.shareId);
  if (!share || !isShareUsable(share) || !findValidDevice(share, pending.did)) {
    consumeShareRequest(reqId);
    return NextResponse.json({ status: "expired" });
  }
  const { token: cookie, maxAgeMs } = signGuestSession({
    shareId: share.id,
    taskId: share.taskId,
    did: pending.did,
    deviceTtlMs: share.deviceTtlMs,
  });
  const res = NextResponse.json({ status: "approved", taskId: share.taskId, grants: share.grants });
  res.cookies.set(COOKIE_NAME, cookie, sessionCookieOptions(maxAgeMs));
  consumeShareRequest(reqId);
  return res;
}
