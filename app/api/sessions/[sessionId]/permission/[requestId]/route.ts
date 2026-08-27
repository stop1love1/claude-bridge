import { NextResponse, type NextRequest } from "next/server";
import { verifyRequestAuth } from "@/libs/auth";
import { answer, consume, getPending } from "@/libs/permissionStore";
import {
  badRequest,
  isValidRequestId,
  isValidSessionId,
} from "@/libs/validate";
import { ok } from "@/libs/apiResponse";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ sessionId: string; requestId: string }> };

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
  const out = { status: cur.status, reason: cur.reason };
  consume(sessionId, requestId);
  return NextResponse.json(out, { status: 200 });
}

interface AnswerBody {
  decision: "allow" | "deny";
  reason?: string;
}

export async function POST(req: NextRequest, ctx: Ctx) {
  if (!verifyRequestAuth(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
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
  return ok();
}
