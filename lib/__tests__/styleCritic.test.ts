import { describe, it, expect } from "vitest";
import {
  STYLE_CRITIC_RETRY_SUFFIX,
  isEligibleForStyleCriticRetry,
  parseCriticVerdict,
  renderStyleRetryContextBlock,
} from "../styleCritic";
import { isAlreadyRetryRun } from "../verifyChain";
import type { Run, RunStyleCritic } from "../meta";

describe("parseCriticVerdict", () => {
  it("returns null for non-object input", () => {
    expect(parseCriticVerdict(null)).toBeNull();
    expect(parseCriticVerdict("not json")).toBeNull();
    expect(parseCriticVerdict(42)).toBeNull();
  });

  it("returns null when verdict is outside the enum", () => {
    expect(parseCriticVerdict({ verdict: "yes", reason: "ok" })).toBeNull();
    expect(parseCriticVerdict({ verdict: "PASS", reason: "ok" })).toBeNull();
    expect(parseCriticVerdict({})).toBeNull();
  });

  it("accepts a minimal match verdict", () => {
    const out = parseCriticVerdict({
      verdict: "match",
      reason: "fits",
      issues: [],
    });
    expect(out).toEqual({ verdict: "match", reason: "fits", issues: [] });
  });

  it("trims and caps issues at 10 entries", () => {
    const issues = Array.from({ length: 15 }, (_, i) => `  issue ${i}  `);
    const out = parseCriticVerdict({
      verdict: "drift",
      reason: " minor stuff ",
      issues,
    });
    expect(out?.reason).toBe("minor stuff");
    expect(out?.issues).toHaveLength(10);
    expect(out?.issues[0]).toBe("issue 0");
    expect(out?.issues[9]).toBe("issue 9");
  });

  it("drops non-string issues silently", () => {
    const out = parseCriticVerdict({
      verdict: "alien",
      reason: "off",
      issues: ["real issue", 42, null, "another"],
    });
    expect(out?.issues).toEqual(["real issue", "another"]);
  });

  it("supplies a default reason when missing", () => {
    const out = parseCriticVerdict({ verdict: "match", issues: [] });
    expect(out?.reason).toContain("no reason");
  });

  it("clamps oversized reason and issue strings", () => {
    const huge = "x".repeat(1000);
    const out = parseCriticVerdict({
      verdict: "drift",
      reason: huge,
      issues: [huge],
    });
    expect(out?.reason.length).toBe(400);
    expect(out?.issues[0].length).toBe(400);
  });
});

describe("renderStyleRetryContextBlock", () => {
  const baseCritic: RunStyleCritic = {
    verdict: "alien",
    reason: "uses raw fetch instead of api client",
    issues: [
      "src/foo.ts:12 — replace fetch() with apiClient.get()",
      "src/bar.tsx:30 — duplicates existing useDebounce hook",
    ],
    durationMs: 1500,
  };

  it("includes the verdict, reason, and bulleted issues", () => {
    const out = renderStyleRetryContextBlock(baseCritic);
    expect(out).toContain("Verdict: ALIEN");
    expect(out).toContain("uses raw fetch");
    expect(out).toContain("- src/foo.ts:12");
    expect(out).toContain("- src/bar.tsx:30");
  });

  it("omits the issues block when none were surfaced", () => {
    const out = renderStyleRetryContextBlock({ ...baseCritic, issues: [] });
    expect(out).not.toContain("### Specific issues");
    expect(out).toContain("Verdict: ALIEN");
  });
});

describe("isEligibleForStyleCriticRetry", () => {
  const baseRun: Run = {
    sessionId: "child-1",
    role: "coder",
    repo: "app-web",
    status: "done",
    startedAt: null,
    endedAt: null,
    parentSessionId: "coord-1",
  };

  it("rejects runs with no parent (coordinator-level)", () => {
    expect(
      isEligibleForStyleCriticRetry({
        finishedRun: { ...baseRun, parentSessionId: null },
        meta: { runs: [] },
      }),
    ).toBe(false);
  });

  it("rejects runs that are themselves a retry of any flavour", () => {
    for (const role of [
      "coder-retry",
      "coder-vretry",
      "coder-cretry",
      "coder-stretry",
      "coder-svretry",
    ]) {
      expect(
        isEligibleForStyleCriticRetry({
          finishedRun: { ...baseRun, role },
          meta: { runs: [] },
        }),
      ).toBe(false);
    }
  });

  it("rejects when a prior -stretry sibling already exists", () => {
    expect(
      isEligibleForStyleCriticRetry({
        finishedRun: baseRun,
        meta: {
          runs: [
            baseRun,
            { ...baseRun, sessionId: "child-2", role: "coder-stretry" },
          ],
        },
      }),
    ).toBe(false);
  });

  it("accepts a clean coder run with no prior stretry sibling", () => {
    expect(
      isEligibleForStyleCriticRetry({
        finishedRun: baseRun,
        meta: { runs: [baseRun] },
      }),
    ).toBe(true);
  });
});

describe("STYLE_CRITIC_RETRY_SUFFIX", () => {
  it("is recognized by isAlreadyRetryRun so a stretry can't trigger another stretry", () => {
    expect(isAlreadyRetryRun(`coder${STYLE_CRITIC_RETRY_SUFFIX}`)).toBe(true);
  });
});
