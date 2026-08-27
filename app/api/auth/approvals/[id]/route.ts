import { NextResponse, type NextRequest } from "next/server";
import { verifyRequestAuthOrInternal } from "@/libs/auth";
import { checkCsrf } from "@/libs/csrf";
import { DEMO_MODE } from "@/libs/demoMode";
import { answerPendingLogin } from "@/libs/loginApprovals";

export const dynamic = "force-dynamic";

interface AnswerBody {
  decision?: "approved" | "denied";
  reason?: string;
}

type Ctx = { params: Promise<{ id: string }> };

export async function POST(req: NextRequest, ctx: Ctx) {
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
  if (!verifyRequestAuthOrInternal(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const { id } = await ctx.params;
  if (!id) {
    return NextResponse.json({ error: "id required" }, { status: 400 });
  }
  let body: AnswerBody;
  try {
    body = (await req.json()) as AnswerBody;
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  if (body.decision !== "approved" && body.decision !== "denied") {
    return NextResponse.json(
      { error: "decision must be 'approved' or 'denied'" },
      { status: 400 },
    );
  }
  const reason = typeof body.reason === "string" ? body.reason : undefined;
  const updated = answerPendingLogin(id, body.decision, reason);
  if (!updated) {
    return NextResponse.json(
      { error: "pending request not found or expired" },
      { status: 404 },
    );
  }
  return NextResponse.json({ ok: true, status: updated.status });
}
