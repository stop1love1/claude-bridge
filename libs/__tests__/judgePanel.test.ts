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
    const r = aggregatePanel([v("a", "broken", "x")], 3);
    expect(r.verdict).toBe("skipped");
  });

  it("de-dupes and caps concerns at 10", () => {
    const many = Array.from({ length: 15 }, (_, i) => `c${i}`);
    const r = aggregatePanel(
      [v("a", "broken", "x", [...many, "c0"]), v("b", "broken", "y", ["c0", "z"])],
      3,
    );
    expect(r.concerns.length).toBeLessThanOrEqual(10);
    expect(new Set(r.concerns).size).toBe(r.concerns.length);
  });
});

describe("aggregatePanel (partial panel — majority reported, panelSize not reached)", () => {
  const shortfall = /\b2\s*\/\s*3\b/;

  it("two broken votes out of three still block", () => {
    const r = aggregatePanel([v("a", "broken", "x", ["c1"]), v("b", "broken", "y")], 3);
    expect(r.verdict).toBe("broken");
    expect(r.reason).toContain("x");
    expect(r.reason).toContain("y");
    expect(r.reason).toMatch(shortfall);
    expect(r.concerns).toContain("c1");
  });

  it("one broken + one pass out of three is drift, and says so with the count", () => {
    const r = aggregatePanel([v("a", "broken", "x"), v("b", "pass")], 3);
    expect(r.verdict).toBe("drift");
    expect(r.reason).toContain("x");
    expect(r.reason).toMatch(shortfall);
  });

  it("one drift + one pass out of three is drift, and says so with the count", () => {
    const r = aggregatePanel([v("a", "drift", "d1"), v("b", "pass")], 3);
    expect(r.verdict).toBe("drift");
    expect(r.reason).toContain("d1");
    expect(r.reason).toMatch(shortfall);
  });

  it("two drift votes out of three is drift, and says so with the count", () => {
    const r = aggregatePanel([v("a", "drift", "d1"), v("b", "drift", "d2")], 3);
    expect(r.verdict).toBe("drift");
    expect(r.reason).toContain("d1");
    expect(r.reason).toContain("d2");
    expect(r.reason).toMatch(shortfall);
  });

  it("two pass votes out of three still pass, but the reason may not claim consensus", () => {
    const r = aggregatePanel([v("a", "pass"), v("b", "pass")], 3);
    expect(r.verdict).toBe("pass");
    expect(r.reason).toMatch(shortfall);
    expect(r.reason).not.toMatch(/consensus/i);
  });

  it("below majority (1 of 3) is still skipped and reports the count", () => {
    const r = aggregatePanel([v("a", "pass")], 3);
    expect(r.verdict).toBe("skipped");
    expect(r.reason).toMatch(/\b1\s*\/\s*3\b/);
  });

  it("a full panel never understates how many judges reported", () => {
    const understated = /\b[0-2]\s*\/\s*3\b/;
    const allPass = aggregatePanel([v("a", "pass"), v("b", "pass"), v("c", "pass")], 3);
    expect(allPass.verdict).toBe("pass");
    expect(allPass.reason).not.toMatch(understated);

    const blocked = aggregatePanel([v("a", "broken", "x"), v("b", "broken", "y"), v("c", "pass")], 3);
    expect(blocked.verdict).toBe("broken");
    expect(blocked.reason).not.toMatch(understated);
  });
});

describe("aggregatePanel (strict majority — no judge decides alone)", () => {
  const brokenThen = (broken: number, panelSize: number) =>
    aggregatePanel(
      [
        ...Array.from({ length: broken }, (_, i) => v(`b${i}`, "broken", `x${i}`)),
        ...Array.from({ length: panelSize - broken }, (_, i) => v(`p${i}`, "pass")),
      ],
      panelSize,
    ).verdict;

  it("panelSize 2: a single reporting judge decides nothing, in any direction", () => {
    expect(aggregatePanel([v("a", "broken", "x")], 2).verdict).toBe("skipped");
    expect(aggregatePanel([v("a", "drift", "d")], 2).verdict).toBe("skipped");
    expect(aggregatePanel([v("a", "pass")], 2).verdict).toBe("skipped");
  });

  it("panelSize 2: a lone broken on a full panel downgrades to drift, as it does on three", () => {
    const r = aggregatePanel([v("a", "broken", "x", ["c1"]), v("b", "pass")], 2);
    expect(r.verdict).toBe("drift");
    expect(r.concerns).toContain("c1");
  });

  it("panelSize 2: both judges must report broken to block", () => {
    expect(brokenThen(2, 2)).toBe("broken");
  });

  it("panelSize 2: both judges reporting pass still passes", () => {
    expect(aggregatePanel([v("a", "pass"), v("b", "pass")], 2).verdict).toBe("pass");
  });

  it("panelSize 1 is unchanged — the single judge is the whole panel", () => {
    expect(aggregatePanel([v("a", "broken", "x")], 1).verdict).toBe("broken");
    expect(aggregatePanel([v("a", "drift", "d")], 1).verdict).toBe("drift");
    expect(aggregatePanel([v("a", "pass")], 1).verdict).toBe("pass");
    expect(aggregatePanel([], 1).verdict).toBe("skipped");
  });

  it("panelSize 3 is unchanged — quorum 2, block on 2", () => {
    expect(aggregatePanel([v("a", "pass")], 3).verdict).toBe("skipped");
    expect(aggregatePanel([v("a", "pass"), v("b", "pass")], 3).verdict).toBe("pass");
    expect(brokenThen(1, 3)).toBe("drift");
    expect(brokenThen(2, 3)).toBe("broken");
  });

  it("panelSize 4: quorum rises to 3 and blocking needs 3, not 2", () => {
    expect(aggregatePanel([v("a", "pass"), v("b", "pass")], 4).verdict).toBe("skipped");
    expect(
      aggregatePanel([v("a", "pass"), v("b", "pass"), v("c", "pass")], 4).verdict,
    ).toBe("pass");
    expect(brokenThen(2, 4)).toBe("drift");
    expect(brokenThen(3, 4)).toBe("broken");
  });

  it("panelSize 5 is unchanged — quorum 3, block on 3", () => {
    expect(aggregatePanel([v("a", "pass"), v("b", "pass")], 5).verdict).toBe("skipped");
    expect(
      aggregatePanel([v("a", "pass"), v("b", "pass"), v("c", "pass")], 5).verdict,
    ).toBe("pass");
    expect(brokenThen(2, 5)).toBe("drift");
    expect(brokenThen(3, 5)).toBe("broken");
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
