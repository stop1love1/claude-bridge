import { NextResponse, type NextRequest } from "next/server";
import { verifyRequestAuth } from "@/lib/auth";
import { answerPendingLogin } from "@/lib/loginApprovals";

export const dynamic = "force-dynamic";

interface AnswerBody {
  decision?: "approved" | "denied";
  reason?: string;
}

type Ctx = { params: Promise<{ id: string }> };

/**
 * POST /api/auth/approvals/[id]
 *
 * The signed-in operator approves or denies a pending device login.
 * Auth is gated by the proxy. Returns the updated pending record
 * (or 404 when the entry has already expired / been consumed).
 *
 * The new device picks up the decision via its own poll on
 * `GET /api/auth/login/pending/[id]` and then signs in if approved.
 */
export async function POST(req: NextRequest, ctx: Ctx) {
  if (!verifyRequestAuth(req)) {
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
