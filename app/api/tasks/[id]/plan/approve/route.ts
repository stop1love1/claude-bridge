import { NextResponse, type NextRequest } from "next/server";
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { SESSIONS_DIR } from "@/libs/paths";
import { readMeta, readIntake, setIntake } from "@/libs/meta";
import { canApprove, type IntakeAnswer } from "@/libs/planGate";
import { continueCoordinator } from "@/libs/planGateLifecycle";
import { readPlanGateConfig } from "@/libs/planGateConfig";
import { verifyRequestActor } from "@/libs/auth";
import { isValidTaskId } from "@/libs/tasks";
import { badRequest } from "@/libs/validate";
import { checkCsrf } from "@/libs/csrf";
import { checkRateLimit } from "@/libs/rateLimit";
import { getClientIp } from "@/libs/clientIp";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

interface ApproveBody {
  action?: "approve" | "request-changes" | "reject";
  answers?: Array<{ questionId: string; answer: string }>;
  note?: string;
}

/**
 * Intent & Planning Gate: approve / request-changes / reject a task's
 * intake plan. Approve requires the operator (or a guest with the
 * `approvePlan` grant — enforced both here and in the guest allowlist).
 */
export async function POST(req: NextRequest, ctx: Ctx) {
  const { id } = await ctx.params;
  if (!isValidTaskId(id)) return badRequest("invalid task id");

  const csrf = checkCsrf(req);
  if (!csrf.ok) {
    return NextResponse.json({ error: "csrf check failed", reason: csrf.reason ?? null }, { status: 403 });
  }
  const denied = checkRateLimit("tasks:plan-approve", getClientIp(req.headers), 30, 60_000);
  if (denied) {
    return NextResponse.json(denied.body, { status: denied.status, headers: denied.headers });
  }

  const actor = verifyRequestActor(req);
  if (!actor) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const approverActor =
    actor.kind === "guest"
      ? { kind: "guest" as const, grants: { approvePlan: actor.grants.approvePlan } }
      : { kind: "operator" as const };
  if (!canApprove(approverActor)) {
    return NextResponse.json({ error: "not allowed to approve plans" }, { status: 403 });
  }

  let body: ApproveBody;
  try { body = (await req.json()) as ApproveBody; } catch { return badRequest("invalid JSON body"); }
  const action = body.action ?? "approve";

  const sessionsDir = join(SESSIONS_DIR, id);
  const meta = readMeta(sessionsDir);
  if (!meta) return NextResponse.json({ error: "task not found" }, { status: 404 });
  const intake = readIntake(sessionsDir);
  if (!intake || intake.status === "none") {
    return NextResponse.json({ error: "no plan to act on" }, { status: 409 });
  }

  const label = actor.kind === "guest" ? `guest:${actor.did.slice(0, 8)}` : "operator";
  const nowIso = new Date().toISOString();

  if (action === "reject") {
    const rec = await setIntake(sessionsDir, {
      status: "error",
      summary: (body.note ?? "rejected").slice(0, 500),
    });
    return NextResponse.json({ ok: true, intake: rec });
  }

  if (action === "request-changes") {
    // Enforce maxClarifyRounds: cap operator-driven re-plan cycles so an
    // endless "request changes" loop can't churn the planner forever. Past
    // the cap the operator must approve or reject the current plan.
    const cfg = readPlanGateConfig();
    if (intake.rounds >= cfg.maxClarifyRounds) {
      return NextResponse.json(
        {
          error: "max clarify rounds reached",
          reason: `re-planning is capped at ${cfg.maxClarifyRounds} round(s) — approve or reject the current plan`,
          intake,
        },
        { status: 409 },
      );
    }
    const rec = await setIntake(sessionsDir, { status: "planning", rounds: intake.rounds + 1 });
    // Re-dispatch planning with the operator note. `replan` flips the
    // coordinator message to "re-plan" (NOT "gate is now open") so it
    // doesn't try to dispatch coders against the still-closed gate.
    await continueCoordinator(
      id,
      sessionsDir,
      `Operator feedback: ${body.note ?? "requested changes"}`,
      { replan: true },
    );
    return NextResponse.json({ ok: true, intake: rec });
  }

  // action === "approve". Idempotent: already approved → no-op 200.
  if (intake.status === "approved") {
    return NextResponse.json({ ok: true, intake, idempotent: true });
  }

  const answers: IntakeAnswer[] = Array.isArray(body.answers)
    ? body.answers
        .filter((a) => a && typeof a.questionId === "string" && typeof a.answer === "string")
        .map((a) => ({ questionId: a.questionId, answer: a.answer.slice(0, 4000), answeredBy: label, at: nowIso }))
    : [];

  // Append answers into plan.md so downstream coders (via loadSharedPlan) see them.
  if (answers.length > 0) {
    try {
      const block =
        "\n\n## Answers (operator/guest)\n" +
        answers.map((a) => `- **${a.questionId}** — ${a.answer}`).join("\n") + "\n";
      appendFileSync(join(sessionsDir, "plan.md"), block, "utf8");
    } catch (err) {
      console.warn("[plan-gate] failed to append answers to plan.md:", err);
    }
  }

  const rec = await setIntake(sessionsDir, {
    status: "approved",
    answers: [...intake.answers, ...answers],
    approvedBy: { kind: actor.kind, label, at: nowIso },
  });
  await continueCoordinator(id, sessionsDir, intake.summary);
  return NextResponse.json({ ok: true, intake: rec });
}
