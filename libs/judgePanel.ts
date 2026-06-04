/**
 * Generic N-judge quality panel. Semantic-agnostic: it fans out the
 * existing single-judge `runAgentGate` runner once per lens and a pure
 * `aggregatePanel` applies majority consensus. Callers (e.g.
 * `semanticVerifier.ts`) own the lens definitions + verdict parsing.
 * See docs/superpowers/specs/2026-06-04-reliability-amplifier-design.md.
 */
import { runAgentGate, type AgentGateOutcome, type AgentGateOptions } from "./qualityGate";

export interface PanelVote {
  lens: string;
  verdict: "pass" | "drift" | "broken";
  reason: string;
  concerns: string[];
}

export interface PanelAggregate {
  verdict: "pass" | "drift" | "broken" | "skipped";
  reason: string;
  concerns: string[];
}

const CONCERNS_CAP = 10;

/**
 * Majority rule over the usable votes (skipped judges already dropped by
 * the caller). `panelSize` is the number of judges DISPATCHED — used to
 * decide whether enough reported back to be conclusive.
 *
 *   broken  : >= ceil(panelSize/2) votes are "broken"
 *   drift   : not majority-broken, but >= 1 broken OR >= 1 drift
 *             (a minority "broken" surfaces as drift, never vanishes)
 *   pass    : every usable vote is "pass"
 *   skipped : fewer than ceil(panelSize/2) usable votes (inconclusive) —
 *             fail-soft, the commit proceeds, never hard-block on infra loss
 */
export function aggregatePanel(votes: PanelVote[], panelSize: number): PanelAggregate {
  const majority = Math.ceil(panelSize / 2);
  if (votes.length < majority) {
    return {
      verdict: "skipped",
      reason: `inconclusive panel: only ${votes.length}/${panelSize} judges reported a usable verdict`,
      concerns: [],
    };
  }
  const broken = votes.filter((v) => v.verdict === "broken");
  const drift = votes.filter((v) => v.verdict === "drift");
  const dedupeCap = (xs: string[]) => Array.from(new Set(xs)).slice(0, CONCERNS_CAP);

  if (broken.length >= majority) {
    return {
      verdict: "broken",
      reason: broken.map((v) => `[${v.lens}] ${v.reason}`).join(" · "),
      concerns: dedupeCap(broken.flatMap((v) => v.concerns)),
    };
  }
  if (broken.length >= 1 || drift.length >= 1) {
    const flagged = [...broken, ...drift];
    return {
      verdict: "drift",
      reason: flagged.map((v) => `[${v.lens}] ${v.reason}`).join(" · "),
      concerns: dedupeCap(flagged.flatMap((v) => v.concerns)),
    };
  }
  return { verdict: "pass", reason: "panel consensus: pass", concerns: [] };
}

export interface PanelLens {
  /** Short key — also used in the verdict filename + vote label. */
  key: string;
  /** One-line lens nudge appended to the base brief. */
  nudge: string;
}

export type GateRunner = (opts: AgentGateOptions) => Promise<AgentGateOutcome>;

export interface RunGatePanelOptions {
  appPath: string;
  taskId: string;
  finishedRun: AgentGateOptions["finishedRun"];
  taskTitle: string;
  taskBody: string;
  /** Playbook role for every judge (e.g. "semantic-verifier"). */
  role: string;
  /** Base brief shared by all lenses. */
  baseBrief: string;
  /** Verdict filenames are `<prefix>-<lens.key>.json`. */
  verdictFilePrefix: string;
  lenses: PanelLens[];
  /** Injected for tests; defaults to the real runAgentGate. */
  gateRunner?: GateRunner;
}

/**
 * Run one judge per lens concurrently. Returns the raw outcome per lens;
 * the caller parses each verdict with its own schema validator.
 */
export async function runGatePanel(
  opts: RunGatePanelOptions,
): Promise<Array<{ lens: string; outcome: AgentGateOutcome }>> {
  const run = opts.gateRunner ?? runAgentGate;
  return Promise.all(
    opts.lenses.map(async (lens) => ({
      lens: lens.key,
      outcome: await run({
        appPath: opts.appPath,
        taskId: opts.taskId,
        finishedRun: opts.finishedRun,
        taskTitle: opts.taskTitle,
        taskBody: opts.taskBody,
        role: opts.role,
        briefBody: `${opts.baseBrief}\n\n## Lens: ${lens.key}\n${lens.nudge}`,
        verdictFileName: `${opts.verdictFilePrefix}-${lens.key}.json`,
      }),
    })),
  );
}
