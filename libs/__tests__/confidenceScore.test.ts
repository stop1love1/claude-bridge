import { describe, it, expect } from "vitest";
import { computeConfidence, shouldHoldOutward } from "../confidenceScore";
import type { Run } from "../meta";

function run(partial: Partial<Run>): Run {
  return {
    sessionId: "00000000-0000-4000-8000-000000000001",
    role: "coder", repo: "app", status: "done", startedAt: null, endedAt: null,
    ...partial,
  };
}

describe("computeConfidence", () => {
  it("all gates clean → 100 / high", () => {
    const c = computeConfidence(run({
      verify: { steps: [], passed: true, startedAt: "", endedAt: "" },
      verifier: { verdict: "pass", reason: "", claimedFiles: [], actualFiles: [], unmatchedClaims: [], unclaimedActual: [], durationMs: 1 },
      styleCritic: { verdict: "match", reason: "", issues: [], durationMs: 1 },
      semanticVerifier: { verdict: "pass", reason: "", concerns: [], durationMs: 1, panelSize: 3,
        votes: [
          { lens: "correctness", verdict: "pass", reason: "" },
          { lens: "edge-cases", verdict: "pass", reason: "" },
          { lens: "regression", verdict: "pass", reason: "" },
        ] },
    }));
    expect(c.score).toBe(100);
    expect(c.band).toBe("high");
  });

  it("a split semantic panel costs 10 even with a pass verdict", () => {
    const c = computeConfidence(run({
      semanticVerifier: { verdict: "pass", reason: "", concerns: [], durationMs: 1, panelSize: 3,
        votes: [
          { lens: "correctness", verdict: "pass", reason: "" },
          { lens: "edge-cases", verdict: "drift", reason: "" },
          { lens: "regression", verdict: "pass", reason: "" },
        ] },
    }));
    expect(c.score).toBe(90);
  });

  it("semantic drift + style drift grade down", () => {
    const c = computeConfidence(run({
      styleCritic: { verdict: "drift", reason: "", issues: [], durationMs: 1 },
      semanticVerifier: { verdict: "drift", reason: "", concerns: [], durationMs: 1 },
    }));
    // -8 (style drift) -15 (semantic drift) = 77
    expect(c.score).toBe(77);
    expect(c.band).toBe("medium");
  });

  it("broken semantic → low band", () => {
    const c = computeConfidence(run({
      semanticVerifier: { verdict: "broken", reason: "", concerns: [], durationMs: 1 },
    }));
    expect(c.score).toBe(60);
    expect(c.band).toBe("medium");
  });

  it("penalises hallucinated claims, capped", () => {
    const c = computeConfidence(run({
      verifier: { verdict: "pass", reason: "", claimedFiles: [], actualFiles: [],
        unmatchedClaims: ["a", "b", "c", "d", "e"], unclaimedActual: [], durationMs: 1 },
    }));
    // cap -12 for unmatchedClaims
    expect(c.score).toBe(88);
  });

  it("clamps at 0", () => {
    const c = computeConfidence(run({
      verify: { steps: [], passed: false, startedAt: "", endedAt: "" },
      verifier: { verdict: "broken", reason: "", claimedFiles: [], actualFiles: [], unmatchedClaims: ["x","y","z","w"], unclaimedActual: [], durationMs: 1 },
      styleCritic: { verdict: "alien", reason: "", issues: [], durationMs: 1 },
      semanticVerifier: { verdict: "broken", reason: "", concerns: [], durationMs: 1 },
    }));
    expect(c.score).toBe(0);
    expect(c.band).toBe("low");
  });
});

describe("shouldHoldOutward", () => {
  const cfg = { enabled: true, threshold: 70 };
  it("holds a low score in the live tree", () => {
    expect(shouldHoldOutward(60, cfg, false)).toBe(true);
  });
  it("does not hold at/above threshold", () => {
    expect(shouldHoldOutward(70, cfg, false)).toBe(false);
    expect(shouldHoldOutward(85, cfg, false)).toBe(false);
  });
  it("never holds when disabled", () => {
    expect(shouldHoldOutward(10, { enabled: false, threshold: 70 }, false)).toBe(false);
  });
  it("never holds in worktree mode (v1 limitation)", () => {
    expect(shouldHoldOutward(10, cfg, true)).toBe(false);
  });
});
