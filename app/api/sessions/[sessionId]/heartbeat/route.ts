import { NextResponse, type NextRequest } from "next/server";
import { verifyRequestAuthOrInternal } from "@/libs/auth";
import { recordHeartbeat } from "@/libs/heartbeat";
import { badRequest, isValidSessionId } from "@/libs/validate";
import { ok } from "@/libs/apiResponse";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ sessionId: string }> };

export async function POST(req: NextRequest, ctx: Ctx) {
  if (!verifyRequestAuthOrInternal(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const { sessionId } = await ctx.params;
  if (!isValidSessionId(sessionId)) return badRequest("invalid sessionId");
  recordHeartbeat(sessionId);
  return ok();
}
