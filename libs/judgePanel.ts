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
 * @param expectedLenses every lens the panel was supposed to hear from.
 *   Optional, and worth supplying: without it a shortfall can only be
 *   reported as a count, and "partial panel: 2/3" reads like two judges
 *   agreeing when it can equally mean one judge died and two survived. A
 *   judge that produced no verdict crashed, timed out or was killed — it did
 *   not abstain, and the difference changes whether you trust the result.
 */
export function aggregatePanel(
  votes: PanelVote[],
  panelSize: number,
  expectedLenses?: string[],
): PanelAggregate {
  const majority = Math.floor(panelSize / 2) + 1;
  const silentBefore = (expectedLenses ?? []).filter(
    (l) => !votes.some((v) => v.lens === l),
  );
  if (votes.length < majority) {
    return {
      verdict: "skipped",
      reason:
        `inconclusive panel: only ${votes.length}/${panelSize} judges reported a usable verdict` +
        (silentBefore.length > 0
          ? `; no verdict from ${silentBefore.map((l) => `[${l}]`).join(", ")}`
          : ""),
      concerns: [],
    };
  }
  const broken = votes.filter((v) => v.verdict === "broken");
  const drift = votes.filter((v) => v.verdict === "drift");
  const dedupeCap = (xs: string[]) => Array.from(new Set(xs)).slice(0, CONCERNS_CAP);
  const partial = votes.length < panelSize;
  const heard = new Set(votes.map((v) => v.lens));
  const silent = (expectedLenses ?? []).filter((l) => !heard.has(l));
  const quorum =
    `${votes.length}/${panelSize} judges reported` +
    (silent.length > 0
      ? `; no verdict from ${silent.map((l) => `[${l}]`).join(", ")} ` +
        `(crashed, timed out or killed — a missing judge, not a dissent)`
      : "");
  const withQuorum = (reason: string) => (partial ? `${reason} (partial panel: ${quorum})` : reason);

  if (broken.length >= majority) {
    return {
      verdict: "broken",
      reason: withQuorum(broken.map((v) => `[${v.lens}] ${v.reason}`).join(" · ")),
      concerns: dedupeCap(broken.flatMap((v) => v.concerns)),
    };
  }
  if (broken.length >= 1 || drift.length >= 1) {
    const flagged = [...broken, ...drift];
    return {
      verdict: "drift",
      reason: withQuorum(flagged.map((v) => `[${v.lens}] ${v.reason}`).join(" · ")),
      concerns: dedupeCap(flagged.flatMap((v) => v.concerns)),
    };
  }
  return {
    verdict: "pass",
    reason: partial ? `partial panel: ${quorum}; all who reported pass` : "panel consensus: pass",
    concerns: [],
  };
}

export interface PanelLens {
  key: string;
  nudge: string;
}

export type GateRunner = (opts: AgentGateOptions) => Promise<AgentGateOutcome>;

export interface RunGatePanelOptions {
  appPath: string;
  taskId: string;
  finishedRun: AgentGateOptions["finishedRun"];
  taskTitle: string;
  taskBody: string;
  role: string;
  baseBrief: string;
  verdictFilePrefix: string;
  lenses: PanelLens[];
  gateRunner?: GateRunner;
}

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
        runRole: `${opts.role}-${lens.key}`,
        briefBody: `${opts.baseBrief}\n\n## Lens: ${lens.key}\n${lens.nudge}`,
        verdictFileName: `${opts.verdictFilePrefix}-${lens.key}.json`,
      }),
    })),
  );
}
