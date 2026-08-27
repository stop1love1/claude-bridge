import { NextResponse, type NextRequest } from "next/server";
import { badRequest } from "@/libs/validate";
import { checkCsrf } from "@/libs/csrf";
import { DEMO_MODE } from "@/libs/demoMode";
import { checkRateLimit } from "@/libs/rateLimit";
import { getClientIp } from "@/libs/clientIp";
import {
  COOKIE_NAME,
  sessionCookieOptions,
  signGuestSession,
  verifyRequestActor,
} from "@/libs/auth";
import { getShare, isShareUsable, verifyShareToken } from "@/libs/shareStore";
import { createShareRequest } from "@/libs/shareApprovals";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

interface AccessBody {
  token?: unknown;
  name?: unknown;
}

export async function POST(req: NextRequest, ctx: Ctx) {
  if (DEMO_MODE) {
    return NextResponse.json({ error: "demo mode" }, { status: 503 });
  }
  const csrf = checkCsrf(req);
  if (!csrf.ok) {
    return NextResponse.json({ error: "csrf check failed", reason: csrf.reason ?? null }, { status: 403 });
  }
  const denied = checkRateLimit("share:access:ip", getClientIp(req.headers), 20, 60_000);
  if (denied) {
    return NextResponse.json(denied.body, { status: denied.status, headers: denied.headers });
  }

  const { id } = await ctx.params;
  let body: AccessBody;
  try {
    body = (await req.json()) as AccessBody;
  } catch {
    return badRequest("invalid JSON body");
  }
  const token = typeof body.token === "string" ? body.token : "";
  const name = typeof body.name === "string" ? body.name.trim().slice(0, 80) : "";

  const share = getShare(id);
  if (!share || !isShareUsable(share) || !verifyShareToken(id, token)) {
    return NextResponse.json({ error: "invalid or expired share link" }, { status: 403 });
  }

  const actor = verifyRequestActor(req);
  if (actor?.kind === "guest" && actor.share.id === id) {
    const { token: cookie, maxAgeMs } = signGuestSession({
      shareId: share.id,
      taskId: share.taskId,
      did: actor.did,
      deviceTtlMs: share.deviceTtlMs,
    });
    const res = NextResponse.json({ status: "approved", taskId: share.taskId, grants: share.grants });
    res.cookies.set(COOKIE_NAME, cookie, sessionCookieOptions(maxAgeMs));
    return res;
  }

  const request = createShareRequest({
    shareId: share.id,
    taskId: share.taskId,
    displayName: name || "Guest",
    ip: getClientIp(req.headers),
    userAgent: req.headers.get("user-agent") ?? "",
  });
  return NextResponse.json({ status: "pending", requestId: request.id, taskId: share.taskId });
}
