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
  if (DEMO_MODE) {
    return NextResponse.json({ error: "demo mode" }, { status: 503 });
  }
  // /api/auth/* is excluded from the proxy matcher, so the CSRF check
  // doesn't run automatically. checkCsrf still allows internal-token
  // callers (the CLI approve script), so the bypass path is intact.
  const csrf = checkCsrf(req);
  if (!csrf.ok) {
    return NextResponse.json(
      { error: "csrf check failed", reason: csrf.reason ?? null },
      { status: 403 },
    );
  }
  // Accept either browser cookie (UI-mounted LoginApprovalDialog) OR
  // the per-install internal-bypass token (terminal CLI script
  // `bun scripts/approve-login.ts`). The CLI path reads the token
  // straight from the local bridge.json — the operator never has to
  // copy or expose the bypass secret.
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
