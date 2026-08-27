import type { Meta, Run, RunVerify, RunVerifier, RunStyleCritic, RunSemanticVerifier } from "./meta";
import { parseRole } from "./retryLadder";

export type GateVerdict = "pass" | "fail" | "drift" | "skipped" | "held";

export interface GateStatusEntry {
  name: string;
  verdict: GateVerdict;
  detail?: string;
}

export interface GateStatus {
  gates: GateStatusEntry[];
  allGreen: boolean;
}

const ICON: Record<GateVerdict, string> = {
  pass: "✅",
  fail: "🔴",
  drift: "🟠",
  held: "🟡",
  skipped: "⚪",
};

const GREEN_VERDICTS: ReadonlySet<GateVerdict> = new Set(["pass", "drift", "skipped"]);

type Confidence = NonNullable<Run["confidence"]>;

function verifyEntry(v: RunVerify): { verdict: GateVerdict; detail: string } {
  if (v.passed) return { verdict: "pass", detail: "all steps passed" };
  const failed = v.steps.filter((s) => !s.ok).map((s) => s.name);
  return {
    verdict: "fail",
    detail: failed.length > 0 ? `${failed.join(", ")} failed` : "verify failed",
  };
}

function verifierEntry(v: RunVerifier): { verdict: GateVerdict; detail: string } {
  if (v.verdict === "pass") return { verdict: "pass", detail: v.reason };
  if (v.verdict === "skipped") return { verdict: "skipped", detail: v.reason };
  return { verdict: "fail", detail: v.reason };
}

function styleEntry(v: RunStyleCritic): { verdict: GateVerdict; detail: string } {
  if (v.verdict === "match") return { verdict: "pass", detail: v.reason };
  if (v.verdict === "skipped") return { verdict: "skipped", detail: v.reason };
  if (v.verdict === "drift") return { verdict: "drift", detail: v.reason };
  return { verdict: "fail", detail: v.reason };
}

function semanticEntry(v: RunSemanticVerifier): { verdict: GateVerdict; detail: string } {
  if (v.verdict === "pass") return { verdict: "pass", detail: v.reason };
  if (v.verdict === "skipped") return { verdict: "skipped", detail: v.reason };
  if (v.verdict === "drift") return { verdict: "drift", detail: v.reason };
  return { verdict: "fail", detail: v.reason };
}

function confidenceEntry(c: Confidence): { verdict: GateVerdict; detail: string } {
  const base = `score ${c.score} (${c.band})`;
  if (c.heldAt && !c.reviewedBy) {
    return { verdict: "held", detail: `${base}, held pending review` };
  }
  return { verdict: "pass", detail: base };
}

function entriesForRun(run: Run): GateStatusEntry[] {
  const parsed = parseRole(run.role);
  const attemptSuffix = parsed.attempt > 0 ? ` (attempt ${parsed.attempt})` : "";
  const ctx = `${parsed.baseRole}@${run.repo}${attemptSuffix}`;
  const entries: GateStatusEntry[] = [];

  if (run.verify) {
    const { verdict, detail } = verifyEntry(run.verify);
    entries.push({ name: "verify", verdict, detail: `${ctx} — ${detail}` });
  }
  if (run.verifier) {
    const { verdict, detail } = verifierEntry(run.verifier);
    entries.push({ name: "claim", verdict, detail: `${ctx} — ${detail}` });
  }
  if (run.styleCritic) {
    const { verdict, detail } = styleEntry(run.styleCritic);
    entries.push({ name: "style", verdict, detail: `${ctx} — ${detail}` });
  }
  if (run.semanticVerifier) {
    const { verdict, detail } = semanticEntry(run.semanticVerifier);
    entries.push({ name: "semantic", verdict, detail: `${ctx} — ${detail}` });
  }
  if (run.confidence) {
    const { verdict, detail } = confidenceEntry(run.confidence);
    entries.push({ name: "confidence", verdict, detail: `${ctx} — ${detail}` });
  }
  return entries;
}

export function computeGateStatus(meta: Meta): GateStatus {
  const superseded = new Set<string>();
  for (const r of meta.runs) {
    if (r.retryOf) superseded.add(r.retryOf);
  }

  const gates: GateStatusEntry[] = [];
  for (const run of meta.runs) {
    if (superseded.has(run.sessionId)) continue;
    if (parseRole(run.role).baseRole === "coordinator") continue;
    gates.push(...entriesForRun(run));
  }

  const allGreen = gates.every((g) => GREEN_VERDICTS.has(g.verdict));
  return { gates, allGreen };
}

export function renderGateStatusMarkdown(status: GateStatus): string {
  if (status.gates.length === 0) {
    return "## Gate status\n\nNo gates configured.";
  }
  const headline = status.allGreen ? "✅ All gates green" : "🔴 Gate failures present";
  const rows = status.gates.map(
    (g) => `| ${g.name} | ${ICON[g.verdict]} ${g.verdict} | ${g.detail ?? ""} |`,
  );
  return [
    "## Gate status",
    "",
    headline,
    "",
    "| Gate | Verdict | Detail |",
    "| --- | --- | --- |",
    ...rows,
  ].join("\n");
}

export function renderGateStatusLine(status: GateStatus): string {
  if (status.gates.length === 0) return "";
  if (status.allGreen) {
    const drifts = status.gates.filter((g) => g.verdict === "drift").length;
    return drifts > 0
      ? `Gates: ✅ all green (${drifts} drift note${drifts === 1 ? "" : "s"})`
      : "Gates: ✅ all green";
  }
  const bad = status.gates.filter((g) => !GREEN_VERDICTS.has(g.verdict));
  if (bad.length === 1) {
    return `Gates: ${ICON[bad[0].verdict]} ${bad[0].name} ${bad[0].verdict}`;
  }
  return `Gates: 🔴 ${bad.length} gate(s) failing (${bad.map((g) => g.name).join(", ")})`;
}
