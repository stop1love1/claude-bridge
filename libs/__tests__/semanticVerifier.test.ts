import { describe, it, expect } from "vitest";
import {
  SEMANTIC_VERIFIER_RETRY_SUFFIX,
  isEligibleForSemanticVerifierRetry,
  parseSemanticVerdict,
  renderSemanticRetryContextBlock,
} from "../semanticVerifier";
import { isAlreadyRetryRun } from "../verifyChain";
import type { Run, RunSemanticVerifier } from "../meta";

describe("parseSemanticVerdict", () => {
  it("returns null for non-object input", () => {
    expect(parseSemanticVerdict(null)).toBeNull();
    expect(parseSemanticVerdict("nope")).toBeNull();
  });

  it("returns null when verdict is outside the enum", () => {
    expect(
      parseSemanticVerdict({ verdict: "alien", reason: "x" }),
    ).toBeNull();
    expect(
      parseSemanticVerdict({ verdict: "match", reason: "x" }),
    ).toBeNull();
  });

  it("accepts a minimal pass verdict", () => {
    const out = parseSemanticVerdict({
      verdict: "pass",
      reason: "delivered",
      concerns: [],
    });
    expect(out).toEqual({ verdict: "pass", reason: "delivered", concerns: [] });
  });

  it("caps concerns at 10 and trims each", () => {
    const concerns = Array.from({ length: 12 }, (_, i) => ` concern ${i} `);
    const out = parseSemanticVerdict({
      verdict: "broken",
      reason: "missing the actual fix",
      concerns,
    });
    expect(out?.concerns).toHaveLength(10);
    expect(out?.concerns[0]).toBe("concern 0");
  });

  it("drops non-string concerns silently", () => {
    const out = parseSemanticVerdict({
      verdict: "drift",
      reason: "partial",
      concerns: ["real", 42, null, "another"],
    });
    expect(out?.concerns).toEqual(["real", "another"]);
  });

  it("supplies a default reason when missing", () => {
    const out = parseSemanticVerdict({ verdict: "pass" });
    expect(out?.reason).toContain("no reason");
    expect(out?.concerns).toEqual([]);
  });
});

describe("renderSemanticRetryContextBlock", () => {
  const baseVerifier: RunSemanticVerifier = {
    verdict: "broken",
    reason: "endpoint declared but not wired into the router",
    concerns: [
      "POST /foo handler is exported but never registered",
      "no tests cover the new path",
    ],
    durationMs: 2000,
  };

  it("includes verdict, reason, and concerns", () => {
    const out = renderSemanticRetryContextBlock(baseVerifier);
    expect(out).toContain("Verdict: BROKEN");
    expect(out).toContain("endpoint declared but not wired");
    expect(out).toContain("- POST /foo handler");
  });

  it("omits the concerns block when empty", () => {
    const out = renderSemanticRetryContextBlock({
      ...baseVerifier,
      concerns: [],
    });
    expect(out).not.toContain("### Concerns");
  });
});

describe("isEligibleForSemanticVerifierRetry", () => {
  const baseRun: Run = {
    sessionId: "child-1",
    role: "coder",
    repo: "app-web",
    status: "done",
    startedAt: null,
    endedAt: null,
    parentSessionId: "coord-1",
  };

  it("rejects runs with no parent", () => {
    expect(
      isEligibleForSemanticVerifierRetry({
        finishedRun: { ...baseRun, parentSessionId: null },
        meta: { runs: [] },
      }),
    ).toBe(false);
  });

  it("rejects runs that are already a retry of any flavour", () => {
    for (const role of [
      "coder-retry",
      "coder-vretry",
      "coder-cretry",
      "coder-stretry",
      "coder-svretry",
    ]) {
      expect(
        isEligibleForSemanticVerifierRetry({
          finishedRun: { ...baseRun, role },
          meta: { runs: [] },
        }),
      ).toBe(false);
    }
  });

  it("rejects when a prior -svretry sibling already exists", () => {
    expect(
      isEligibleForSemanticVerifierRetry({
        finishedRun: baseRun,
        meta: {
          runs: [
            baseRun,
            { ...baseRun, sessionId: "child-2", role: "coder-svretry" },
          ],
        },
      }),
    ).toBe(false);
  });

  it("accepts a clean coder run with no prior svretry sibling", () => {
    expect(
      isEligibleForSemanticVerifierRetry({
        finishedRun: baseRun,
        meta: { runs: [baseRun] },
      }),
    ).toBe(true);
  });
});

describe("SEMANTIC_VERIFIER_RETRY_SUFFIX", () => {
  it("is recognized by isAlreadyRetryRun so a svretry can't trigger another svretry", () => {
    expect(
      isAlreadyRetryRun(`coder${SEMANTIC_VERIFIER_RETRY_SUFFIX}`),
    ).toBe(true);
  });
});
