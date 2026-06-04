/**
 * Bridge-side orchestration that runs after a `planner` child exits while
 * a task's intake is in `planning`. Reads the planner's output, derives
 * the gate verdict, and advances intake → approved | awaiting-approval.
 * On auto-approval it continues the coordinator via the same resume path
 * the `continue` route uses, so coding proceeds with the plan injected.
 *
 * Lazy-requires coordinator/resumeSession (matching the other post-exit
 * gate modules) to avoid an import cycle.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { readMeta, readIntake, setIntake } from "./meta";
import { deriveGateVerdict, type GateVerdict, type IntakeStatus } from "./planGate";

export function computeNextIntakeStatus(args: {
  verdict: GateVerdict;
  submitterCanApprove: boolean;
}): Extract<IntakeStatus, "approved" | "awaiting-approval"> {
  if (args.verdict === "clear" && args.submitterCanApprove) return "approved";
  return "awaiting-approval";
}

function readPlannerOutput(sessionsDir: string) {
  let intakeJson: unknown = null;
  const jsonPath = join(sessionsDir, "intake.json");
  if (existsSync(jsonPath)) {
    try { intakeJson = JSON.parse(readFileSync(jsonPath, "utf8")); } catch { intakeJson = null; }
  }
  let planMd: string | null = null;
  const planPath = join(sessionsDir, "plan.md");
  if (existsSync(planPath)) {
    try { planMd = readFileSync(planPath, "utf8"); } catch { planMd = null; }
  }
  return { intakeJson: intakeJson as Record<string, unknown> | null, planMd };
}

/**
 * Called on planner exit. No-op unless the task's intake is in `planning`.
 * Derives verdict, advances status, and (on auto-approval) continues the
 * coordinator. Fail-soft: any error parks intake at `error` so the
 * operator escape hatch shows, never throws into the lifecycle.
 */
export async function resolvePlanGateAfterPlanner(args: {
  taskId: string;
  sessionsDir: string;
  plannerSessionId: string;
}): Promise<void> {
  try {
    const intake = readIntake(args.sessionsDir);
    if (!intake || intake.status !== "planning") return;

    const derived = deriveGateVerdict(readPlannerOutput(args.sessionsDir));
    // The planner exit is a server event with no actor, so only an
    // operator-submitted task auto-approves a clear plan here. A guest with
    // the approvePlan grant approves with an explicit click (the approve
    // endpoint is the only place that capability is checked server-side).
    const submitterCanApprove = intake.submittedBy?.kind === "operator";

    const next = computeNextIntakeStatus({ verdict: derived.verdict, submitterCanApprove });
    await setIntake(args.sessionsDir, {
      status: next,
      verdict: derived.verdict,
      summary: derived.summary,
      questions: derived.questions,
      planSessionId: args.plannerSessionId,
      rounds: intake.rounds + 1,
      ...(next === "approved"
        ? { approvedBy: { kind: "operator", label: "auto (clear plan)", at: new Date().toISOString() } }
        : {}),
    });

    if (next === "approved") {
      await continueCoordinator(args.taskId, args.sessionsDir, derived.summary);
    }
  } catch (err) {
    console.error("[plan-gate] resolvePlanGateAfterPlanner failed:", err);
    try { await setIntake(args.sessionsDir, { status: "error" }); } catch { /* ignore */ }
  }
}

/**
 * Resume the coordinator (or spawn one) after a plan-gate transition.
 *
 * `opts.replan` distinguishes the two callers: approval (the gate is now
 * open → dispatch coders) vs `request-changes` (re-plan → spawn a fresh
 * planner, gate stays closed). Sending the wrong message — e.g. "gate is
 * now open" on a re-plan — makes the coordinator try to dispatch coders
 * that immediately bounce off the still-closed gate.
 */
export async function continueCoordinator(
  taskId: string,
  sessionsDir: string,
  summary: string | null,
  opts?: { replan?: boolean },
): Promise<void> {
  // Lazy-require to dodge the import cycle (coordinator → runLifecycle → here).
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { resumeSessionWithLifecycle } = require("./resumeSession") as typeof import("./resumeSession");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { spawnCoordinatorForTask } = require("./coordinator") as typeof import("./coordinator");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { BRIDGE_ROOT } = require("./paths") as typeof import("./paths");

  const meta = readMeta(sessionsDir);
  if (!meta) return;

  const coordinators = meta.runs.filter((r) => r.role === "coordinator");
  // A live coordinator will react to the gate change on its own turn (its
  // next coder spawn now passes the gate; the nudge re-drives it on exit).
  // Resuming it now would race its live stdout — skip.
  if (coordinators.some((r) => r.status === "running" || r.status === "queued")) return;

  const msg = opts?.replan
    ? `Re-plan requested for bridge task ${taskId}. ${summary ? `${summary} ` : ""}The planning gate is OPEN AGAIN (intake.status=planning): spawn a FRESH planner, address the feedback, and do NOT dispatch coders until the new plan is approved.`
    : `Plan approved for bridge task ${taskId}. ${summary ? `Goal: ${summary} ` : ""}Read sessions/${taskId}/plan.md (the shared plan) and proceed with implementation — dispatch the coder(s). The bridge gate is now open.`;

  // Resume the most recent finished coordinator if there is one; else spawn.
  const finished = coordinators[coordinators.length - 1];
  if (finished) {
    resumeSessionWithLifecycle({
      cwd: BRIDGE_ROOT,
      sessionId: finished.sessionId,
      message: msg,
      settings: { mode: "bypassPermissions" },
      context: `plan-gate-continue ${taskId}`,
    });
  } else {
    void spawnCoordinatorForTask({
      id: meta.taskId,
      title: meta.taskTitle,
      body: meta.taskBody,
      app: meta.taskApp ?? null,
      effort: meta.taskEffort ?? null,
    });
  }
}
