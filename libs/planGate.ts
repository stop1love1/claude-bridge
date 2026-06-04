/**
 * Pure logic for the Intent & Planning Gate (Epic A). No I/O — the route
 * layer computes `gateApplies` (config + actor) and reads/writes intake
 * via `libs/meta.ts`. Kept side-effect-free so it unit-tests trivially.
 * See docs/superpowers/specs/2026-06-04-intent-planning-gate-design.md.
 */

export type IntakeStatus =
  | "none"
  | "planning"
  | "awaiting-approval"
  | "approved"
  | "error";

export type GateVerdict = "clear" | "needs-decision";

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
  /** Planner session that produced the current plan, if any. */
  planSessionId: string | null;
  submittedBy: IntakeActorRef | null;
  approvedBy: (IntakeActorRef & { at: string }) | null;
  /** How many clarify cycles have run (bounded by config.maxClarifyRounds). */
  rounds: number;
  updatedAt: string;
}

/** Roles that never write source — always allowed to run under the gate. */
const NON_MUTATING_ROLES = [
  "planner",
  "reviewer",
  "ui-tester",
  "semantic-verifier",
  "style-critic",
  "devops",
];

/**
 * A role is mutating unless it equals — or is a suffixed variant of
 * (`<base>-...`) — a known analysis role. Handles `coder-phase24`
 * (mutating) and `planner-api` / `ui-tester` (non-mutating).
 */
export function isMutatingRole(role: string): boolean {
  const r = role.toLowerCase();
  for (const base of NON_MUTATING_ROLES) {
    if (r === base || r.startsWith(base + "-")) return false;
  }
  return true;
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
  /** config.operatorEnabled || actor.kind === "guest" — computed by caller. */
  gateApplies: boolean;
}

export interface PlanGateDecision {
  allowed: boolean;
  reason: string;
  /** True when the caller should flip intake → planning and kick the coordinator. */
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
  /** Parsed sessions/<id>/intake.json, or null when absent/corrupt. */
  intakeJson?: {
    verdict?: unknown;
    summary?: unknown;
    questions?: unknown;
  } | null;
  /** Raw sessions/<id>/plan.md text, or null. */
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

/** Extract bullet questions under a `## Questions for the user` heading. */
function parsePlanQuestions(planMd: string): IntakeQuestion[] {
  const lines = planMd.split(/\r?\n/);
  const start = lines.findIndex((l) => /^##\s+questions for the user/i.test(l.trim()));
  if (start === -1) return [];
  const out: IntakeQuestion[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line.startsWith("## ")) break; // next section
    const m = /^[-*]\s+(.*)$/.exec(line);
    if (!m) continue;
    const text = m[1].trim();
    if (!text || /^\(none\)$/i.test(text)) continue;
    out.push({ id: `q${out.length + 1}`, text });
  }
  return out;
}

export function deriveGateVerdict(out: PlannerOutput): DerivedVerdict {
  const j = out.intakeJson;
  if (j && (j.verdict === "clear" || j.verdict === "needs-decision")) {
    const questions = normalizeQuestions(j.questions);
    return {
      verdict: j.verdict === "needs-decision" && questions.length === 0 ? "clear" : j.verdict,
      summary: typeof j.summary === "string" ? j.summary : null,
      questions,
    };
  }
  // Fallback: parse plan.md. Fail open to "clear" when nothing parses.
  const planMd = out.planMd ?? "";
  const questions = planMd ? parsePlanQuestions(planMd) : [];
  return {
    verdict: questions.length > 0 ? "needs-decision" : "clear",
    summary: null,
    questions,
  };
}
