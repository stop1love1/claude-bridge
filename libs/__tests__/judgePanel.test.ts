import { describe, it, expect } from "vitest";
import { aggregatePanel, runGatePanel, type PanelVote, type GateRunner } from "../judgePanel";
import type { Run } from "../meta";

const v = (lens: string, verdict: PanelVote["verdict"], reason = "r", concerns: string[] = []): PanelVote =>
  ({ lens, verdict, reason, concerns });

describe("aggregatePanel (N=3 majority)", () => {
  it("blocks (broken) when >= 2 of 3 are broken", () => {
    const r = aggregatePanel([v("a", "broken", "x"), v("b", "broken", "y"), v("c", "pass")], 3);
    expect(r.verdict).toBe("broken");
    expect(r.reason).toContain("x");
  });

  it("a lone broken (1 of 3) downgrades to drift, not pass", () => {
    const r = aggregatePanel([v("a", "broken", "x", ["c1"]), v("b", "pass"), v("c", "pass")], 3);
    expect(r.verdict).toBe("drift");
    expect(r.concerns).toContain("c1");
  });

  it("any drift with no majority-broken is drift", () => {
    const r = aggregatePanel([v("a", "drift"), v("b", "pass"), v("c", "pass")], 3);
    expect(r.verdict).toBe("drift");
  });

  it("all pass is pass", () => {
    const r = aggregatePanel([v("a", "pass"), v("b", "pass"), v("c", "pass")], 3);
    expect(r.verdict).toBe("pass");
  });

  it("inconclusive (fewer than majority usable) is skipped, never blocks", () => {
    const r = aggregatePanel([v("a", "broken", "x")], 3); // only 1 of 3 judges reported
    expect(r.verdict).toBe("skipped");
  });

  it("de-dupes and caps concerns at 10", () => {
    const many = Array.from({ length: 15 }, (_, i) => `c${i}`);
    const r = aggregatePanel(
      [v("a", "broken", "x", [...many, "c0"]), v("b", "broken", "y", ["c0", "z"])],
      3,
    );
    expect(r.concerns.length).toBeLessThanOrEqual(10);
    expect(new Set(r.concerns).size).toBe(r.concerns.length); // unique
  });
});

const FINISHED: Run = {
  sessionId: "00000000-0000-4000-8000-000000000001",
  role: "coder", repo: "app", status: "done", startedAt: null, endedAt: null,
};

describe("runGatePanel", () => {
  it("runs one judge per lens with distinct verdict files + lens briefs", async () => {
    const calls: Array<{ verdictFileName: string; briefBody: string; runRole?: string }> = [];
    const stub: GateRunner = async (o) => {
      calls.push({ verdictFileName: o.verdictFileName, briefBody: o.briefBody, runRole: o.runRole });
      return { kind: "spawned", sessionId: "s", verdict: { verdict: "pass", reason: "ok" } };
    };
    const results = await runGatePanel({
      appPath: "/app", taskId: "t_20260604_001", finishedRun: FINISHED,
      taskTitle: "T", taskBody: "B", role: "semantic-verifier",
      baseBrief: "BASE", verdictFilePrefix: "semantic-verdict",
      lenses: [
        { key: "correctness", nudge: "N1" },
        { key: "edge-cases", nudge: "N2" },
      ],
      gateRunner: stub,
    });
    expect(results.map((r) => r.lens)).toEqual(["correctness", "edge-cases"]);
    expect(calls.map((c) => c.verdictFileName)).toEqual([
      "semantic-verdict-correctness.json",
      "semantic-verdict-edge-cases.json",
    ]);
    expect(calls.map((c) => c.runRole)).toEqual([
      "semantic-verifier-correctness",
      "semantic-verifier-edge-cases",
    ]);
    expect(calls[0].briefBody).toContain("BASE");
    expect(calls[0].briefBody).toContain("N1");
  });
});
