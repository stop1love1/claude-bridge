import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { readMeta, readIntake, setIntake, emitIntakeAwaitingApproval } from "./meta";
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

export async function resolvePlanGateAfterPlanner(args: {
  taskId: string;
  sessionsDir: string;
  plannerSessionId: string;
}): Promise<void> {
  try {
    const intake = readIntake(args.sessionsDir);
    if (!intake || intake.status !== "planning") return;

    const derived = deriveGateVerdict(readPlannerOutput(args.sessionsDir));
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
    } else {
      const title = readMeta(args.sessionsDir)?.taskTitle ?? args.taskId;
      emitIntakeAwaitingApproval({ taskId: args.taskId, taskTitle: title });
    }
  } catch (err) {
    console.error("[plan-gate] resolvePlanGateAfterPlanner failed:", err);
    try { await setIntake(args.sessionsDir, { status: "error" }); } catch { }
  }
}

export async function continueCoordinator(
  taskId: string,
  sessionsDir: string,
  summary: string | null,
  opts?: { replan?: boolean },
): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { resumeSessionWithLifecycle } = require("./resumeSession") as typeof import("./resumeSession");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { spawnCoordinatorForTask } = require("./coordinator") as typeof import("./coordinator");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { BRIDGE_ROOT } = require("./paths") as typeof import("./paths");

  const meta = readMeta(sessionsDir);
  if (!meta) return;

  const coordinators = meta.runs.filter((r) => r.role === "coordinator");
  if (coordinators.some((r) => r.status === "running" || r.status === "queued")) return;

  const msg = opts?.replan
    ? `Re-plan requested for bridge task ${taskId}. ${summary ? `${summary} ` : ""}The planning gate is OPEN AGAIN (intake.status=planning): spawn a FRESH planner, address the feedback, and do NOT dispatch coders until the new plan is approved.`
    : `Plan approved for bridge task ${taskId}. ${summary ? `Goal: ${summary} ` : ""}Read sessions/${taskId}/plan.md (the shared plan) and proceed with implementation — dispatch the coder(s). The bridge gate is now open.`;

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
