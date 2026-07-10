/**
 * Gate status aggregation (Task 6).
 *
 * Rolls the per-run QA gate results (`verify`, `verifier` (claim-vs-diff),
 * `styleCritic`, `semanticVerifier`, `confidence` — see `libs/meta.ts`)
 * into a compact `{gates, allGreen}` summary the summary API, the
 * Telegram notifier, and the task UI can all render without duplicating
 * the aggregation logic.
 *
 * Retry-chain handling: `libs/retryLadder.ts` guarantees a run's retries
 * only ever chain on the SAME gate that failed (cross-gate retries are
 * blocked), so a run's `role` base and `repo` are invariant along its
 * whole `retryOf` chain. That means the "latest attempt" for a chain is
 * simply: any run that no other run's `retryOf` points at (nothing
 * superseded it). We collect every such chain-head run (excluding
 * coordinator runs) and read whichever gate fields it carries — older,
 * superseded attempts are dropped entirely so a stale PASS can never
 * mask a newer FAIL (or vice versa).
 *
 * Runtime-agnostic: no `node:fs` / server-only imports, so this module
 * is safe to import from API routes, the Telegram notifier, AND
 * "use client" UI components alike (only `import type` pulls from
 * `./meta`, which IS server-only — type-only imports are erased at
 * build time and never reach the client bundle).
 */
import type { Meta, Run, RunVerify, RunVerifier, RunStyleCritic, RunSemanticVerifier } from "./meta";
import { parseRole } from "./retryLadder";

export type GateVerdict = "pass" | "fail" | "skipped" | "held";

export interface GateStatusEntry {
  /** Short gate-kind label: "verify" | "claim" | "style" | "semantic" | "confidence". */
  name: string;
  verdict: GateVerdict;
  /** Human detail — which run/role/repo produced this verdict + why. */
  detail?: string;
}

export interface GateStatus {
  gates: GateStatusEntry[];
  allGreen: boolean;
}

const ICON: Record<GateVerdict, string> = {
  pass: "✅",
  fail: "🔴",
  held: "🟡",
  skipped: "⚪",
};

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
  // "drift" | "broken" — both are meaningful claim-vs-diff mismatches.
  return { verdict: "fail", detail: v.reason };
}

function styleEntry(v: RunStyleCritic): { verdict: GateVerdict; detail: string } {
  if (v.verdict === "match") return { verdict: "pass", detail: v.reason };
  if (v.verdict === "skipped") return { verdict: "skipped", detail: v.reason };
  // "drift" | "alien"
  return { verdict: "fail", detail: v.reason };
}

function semanticEntry(v: RunSemanticVerifier): { verdict: GateVerdict; detail: string } {
  if (v.verdict === "pass") return { verdict: "pass", detail: v.reason };
  if (v.verdict === "skipped") return { verdict: "skipped", detail: v.reason };
  // "drift" | "broken"
  return { verdict: "fail", detail: v.reason };
}

function confidenceEntry(c: Confidence): { verdict: GateVerdict; detail: string } {
  const base = `score ${c.score} (${c.band})`;
  if (c.heldAt && !c.reviewedBy) {
    return { verdict: "held", detail: `${base}, held pending review` };
  }
  return { verdict: "pass", detail: base };
}

/** Build every gate entry present on a single (already chain-head) run. */
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

/**
 * Aggregate gate results across a task's runs, following each retry
 * chain to its newest (non-superseded) attempt. Coordinator runs are
 * always excluded — gates only ever attach to child (coder/reviewer/…)
 * runs. Returns `{gates: [], allGreen: true}` when no run in the task
 * has any gate field set (nothing configured / nothing ran yet).
 */
export function computeGateStatus(meta: Meta): GateStatus {
  const superseded = new Set<string>();
  for (const r of meta.runs) {
    if (r.retryOf) superseded.add(r.retryOf);
  }

  const gates: GateStatusEntry[] = [];
  for (const run of meta.runs) {
    if (superseded.has(run.sessionId)) continue; // an older attempt in its chain
    if (parseRole(run.role).baseRole === "coordinator") continue;
    gates.push(...entriesForRun(run));
  }

  const allGreen = gates.every((g) => g.verdict === "pass" || g.verdict === "skipped");
  return { gates, allGreen };
}

/**
 * Compact `## Gate status` Markdown table — embedded in `summary.md`-
 * adjacent surfaces (currently the summary API response; callers decide
 * whether/where to render it).
 */
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

/**
 * One-line compact rendering for chat surfaces (Telegram Ready-for-
 * review message). Empty string when no gates are configured — callers
 * should skip appending a blank "Gates:" line in that case.
 */
export function renderGateStatusLine(status: GateStatus): string {
  if (status.gates.length === 0) return "";
  if (status.allGreen) return "Gates: ✅ all green";
  const bad = status.gates.filter((g) => g.verdict !== "pass" && g.verdict !== "skipped");
  if (bad.length === 1) {
    return `Gates: ${ICON[bad[0].verdict]} ${bad[0].name} ${bad[0].verdict}`;
  }
  return `Gates: 🔴 ${bad.length} gate(s) failing (${bad.map((g) => g.name).join(", ")})`;
}
