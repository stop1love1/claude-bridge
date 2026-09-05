import { resolveRole } from "./roleRegistry";

export type IntakeStatus =
  | "none"
  | "planning"
  | "awaiting-approval"
  | "approved"
  | "error";

export type GateVerdict = "clear" | "needs-decision" | "unknown";

export interface IntakeQuestion {
  id: string;
  text: string;
  options?: string[];
  recommended?: string;
}

export interface IntakeAnswer {
  questionId: string;
  answer: string;
  answeredBy: string;
  at: string;
}

export interface IntakeActorRef {
  kind: "operator" | "guest";
  label: string;
}

export interface IntakeRecord {
  status: IntakeStatus;
  verdict: GateVerdict | null;
  summary: string | null;
  questions: IntakeQuestion[];
  answers: IntakeAnswer[];
  planSessionId: string | null;
  submittedBy: IntakeActorRef | null;
  approvedBy: (IntakeActorRef & { at: string }) | null;
  rounds: number;
  updatedAt: string;
}

// The role → mutating table lives in `libs/roleRegistry.ts` so the plan gate
// and the per-role tool-restriction applied at spawn time can never disagree.
export function isMutatingRole(role: string): boolean {
  return resolveRole(role).mutating;
}

export type ApproverActor =
  | { kind: "operator" }
  | { kind: "guest"; grants: { approvePlan?: boolean } };

export function canApprove(actor: ApproverActor): boolean {
  if (actor.kind === "operator") return true;
  return actor.grants.approvePlan === true;
}

export interface PlanGateInput {
  role: string;
  intakeStatus: IntakeStatus;
  gateApplies: boolean;
}

export interface PlanGateDecision {
  allowed: boolean;
  reason: string;
  kickPlanning: boolean;
}

export function evaluatePlanGate(input: PlanGateInput): PlanGateDecision {
  if (!input.gateApplies) {
    return { allowed: true, reason: "gate off for this actor", kickPlanning: false };
  }
  if (!isMutatingRole(input.role)) {
    return { allowed: true, reason: "non-mutating role", kickPlanning: false };
  }
  if (input.intakeStatus === "approved") {
    return { allowed: true, reason: "plan approved", kickPlanning: false };
  }
  return {
    allowed: false,
    reason: `plan-gate: intake is '${input.intakeStatus}', not 'approved'`,
    kickPlanning: input.intakeStatus === "none",
  };
}

export function defaultIntake(): IntakeRecord {
  return {
    status: "none",
    verdict: null,
    summary: null,
    questions: [],
    answers: [],
    planSessionId: null,
    submittedBy: null,
    approvedBy: null,
    rounds: 0,
    updatedAt: new Date(0).toISOString(),
  };
}

export interface PlannerOutput {
  intakeJson?: {
    verdict?: unknown;
    summary?: unknown;
    questions?: unknown;
  } | null;
  planMd?: string | null;
}

export interface DerivedVerdict {
  verdict: GateVerdict;
  summary: string | null;
  questions: IntakeQuestion[];
}

function normalizeQuestions(raw: unknown): IntakeQuestion[] {
  if (!Array.isArray(raw)) return [];
  const out: IntakeQuestion[] = [];
  raw.forEach((q, i) => {
    if (!q || typeof q !== "object") return;
    const obj = q as Record<string, unknown>;
    const text = typeof obj.text === "string" ? obj.text.trim() : "";
    if (!text) return;
    out.push({
      id: typeof obj.id === "string" && obj.id ? obj.id : `q${i + 1}`,
      text,
      options:
        Array.isArray(obj.options) && obj.options.every((o) => typeof o === "string")
          ? (obj.options as string[])
          : undefined,
      recommended: typeof obj.recommended === "string" ? obj.recommended : undefined,
    });
  });
  return out;
}

function parsePlanQuestions(planMd: string): IntakeQuestion[] {
  const lines = planMd.split(/\r?\n/);
  const start = lines.findIndex((l) => /^##\s+questions for the user/i.test(l.trim()));
  if (start === -1) return [];
  const out: IntakeQuestion[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line.startsWith("## ")) break;
    const m = /^[-*]\s+(.*)$/.exec(line);
    if (!m) continue;
    const text = m[1].trim();
    if (!text || /^\(none\)$/i.test(text)) continue;
    out.push({ id: `q${out.length + 1}`, text });
  }
  return out;
}

export const CONTRADICTORY_VERDICT_NOTE =
  "plan-gate: the planner reported 'needs-decision' but listed no questions — the verdict is recorded as 'unknown'; review plan.md before approving.";

export function deriveGateVerdict(out: PlannerOutput): DerivedVerdict {
  const j = out.intakeJson;
  const planMd = out.planMd ?? "";
  if (j && (j.verdict === "clear" || j.verdict === "needs-decision")) {
    const summary = typeof j.summary === "string" ? j.summary : null;
    const questions = normalizeQuestions(j.questions);
    if (j.verdict === "needs-decision" && questions.length === 0) {
      const recovered = parsePlanQuestions(planMd);
      if (recovered.length > 0) {
        return { verdict: "needs-decision", summary, questions: recovered };
      }
      return {
        verdict: "unknown",
        summary: summary ? `${CONTRADICTORY_VERDICT_NOTE}\n\n${summary}` : CONTRADICTORY_VERDICT_NOTE,
        questions: [],
      };
    }
    return { verdict: j.verdict, summary, questions };
  }
  if (!planMd) {
    return { verdict: "unknown", summary: null, questions: [] };
  }
  const questions = planMd ? parsePlanQuestions(planMd) : [];
  return {
    verdict: questions.length > 0 ? "needs-decision" : "clear",
    summary: null,
    questions,
  };
}
