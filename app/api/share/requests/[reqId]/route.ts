import { NextResponse, type NextRequest } from "next/server";
import { ok } from "@/libs/apiResponse";
import { badRequest } from "@/libs/validate";
import { answerShareRequest, getShareRequest } from "@/libs/shareApprovals";
import { addDevice, getShare, isShareUsable } from "@/libs/shareStore";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ reqId: string }> };

interface AnswerBody {
  decision?: "approved" | "denied";
  reason?: string;
}

/**
 * POST /api/share/requests/<reqId>
 *
 * Operator approves or denies a pending guest access request. On
 * approval the request's candidate device id is written into the share's
 * device list (with the share's TTL), so the guest's poll can mint a
 * scoped cookie. Operator-only (proxy-gated; CSRF runs in the proxy).
 */
export async function POST(req: NextRequest, ctx: Ctx) {
  const { reqId } = await ctx.params;
  let body: AnswerBody;
  try {
    body = (await req.json()) as AnswerBody;
  } catch {
    return badRequest("invalid JSON body");
  }
  if (body.decision !== "approved" && body.decision !== "denied") {
    return badRequest("decision must be 'approved' or 'denied'");
  }

  const pending = getShareRequest(reqId);
  if (!pending || pending.status !== "pending") {
    return NextResponse.json({ error: "request not found or already answered" }, { status: 404 });
  }

  if (body.decision === "approved") {
    // The share must still be usable at approval time.
    const share = getShare(pending.shareId);
    if (!share || !isShareUsable(share)) {
      answerShareRequest(reqId, "denied", "share no longer available");
      return NextResponse.json({ error: "share revoked or expired" }, { status: 409 });
    }
    addDevice(pending.shareId, {
      did: pending.did,
      label: pending.displayName || "Guest",
      ip: pending.ip,
    });
  }

  const updated = answerShareRequest(reqId, body.decision, body.reason);
  if (!updated) {
    return NextResponse.json({ error: "request not found or expired" }, { status: 404 });
  }
  return ok({ status: updated.status });
}
