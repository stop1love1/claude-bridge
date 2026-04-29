import { NextResponse, type NextRequest } from "next/server";
import { answer, consume, getPending } from "@/libs/permissionStore";
import {
  badRequest,
  isValidRequestId,
  isValidSessionId,
} from "@/libs/validate";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ sessionId: string; requestId: string }> };

/**
 * GET: called by the hook to long-poll for the user's decision. While
 * the request is still `pending` we return HTTP 202 so the hook keeps
 * polling. Once answered we return HTTP 200 with the decision and
 * remove the record from the in-memory store (one-shot delivery).
 */
export async function GET(_req: NextRequest, ctx: Ctx) {
  const { sessionId, requestId } = await ctx.params;
  if (!isValidSessionId(sessionId)) return badRequest("invalid sessionId");
  if (!isValidRequestId(requestId)) return badRequest("invalid requestId");
  const cur = getPending(sessionId, requestId);
  if (!cur) {
    return NextResponse.json(
      { status: "missing", error: "no such request" },
      { status: 404 },
    );
  }
  if (cur.status === "pending") {
    return NextResponse.json({ status: "pending" }, { status: 202 });
  }
  // Final state — return it then drop the entry so it doesn't leak.
  const out = { status: cur.status, reason: cur.reason };
  consume(sessionId, requestId);
  return NextResponse.json(out, { status: 200 });
}

interface AnswerBody {
  decision: "allow" | "deny";
  reason?: string;
}

/**
 * POST: called by the UI when the user clicks Allow / Deny. Marks the
 * request answered. The hook's next long-poll picks this up.
 */
export async function POST(req: NextRequest, ctx: Ctx) {
  const { sessionId, requestId } = await ctx.params;
  if (!isValidSessionId(sessionId)) return badRequest("invalid sessionId");
  if (!isValidRequestId(requestId)) return badRequest("invalid requestId");
  const body = (await req.json()) as Partial<AnswerBody>;
  if (body.decision !== "allow" && body.decision !== "deny") {
    return NextResponse.json(
      { error: "decision must be 'allow' or 'deny'" },
      { status: 400 },
    );
  }
  const updated = answer(sessionId, requestId, body.decision, body.reason);
  if (!updated) {
    return NextResponse.json({ error: "no such request" }, { status: 404 });
  }
  return NextResponse.json({ ok: true });
}
