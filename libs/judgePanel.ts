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
  const partial = votes.length < panelSize;
  const quorum = `${votes.length}/${panelSize} judges reported`;
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
    reason: partial ? `partial panel: ${quorum}, all pass` : "panel consensus: pass",
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
