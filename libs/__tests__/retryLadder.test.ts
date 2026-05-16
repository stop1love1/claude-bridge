import { describe, it, expect } from "vitest";
import {
  checkEligibility,
  countRetryAttempts,
  describeRetry,
  isAnyRetryRole,
  maxAttemptsFor,
  nextRetryRole,
  parseRole,
  renderStrategyPrefix,
  strategyForAttempt,
  totalCapFor,
  totalRetriesInTask,
  DEFAULT_MAX_RETRIES_PER_TASK,
  MAX_RETRY_PER_GATE,
} from "../retryLadder";
import type { Run } from "../meta";
import type { AppRetry } from "../apps";

const PARENT = "00000000-0000-0000-0000-000000000000";

const baseRun = (overrides: Partial<Run> = {}): Run => ({
  sessionId: "11111111-1111-1111-1111-111111111111",
  role: "coder",
  repo: "app-web",
  status: "done",
  startedAt: null,
  endedAt: null,
  parentSessionId: PARENT,
  ...overrides,
});

describe("parseRole", () => {
  it("parses base roles (no retry suffix)", () => {
    expect(parseRole("coder")).toEqual({
      baseRole: "coder",
      gate: null,
      attempt: 0,
    });
    expect(parseRole("api-builder")).toEqual({
      baseRole: "api-builder",
      gate: null,
      attempt: 0,
    });
  });

  it("recognizes attempt 1 of every gate (legacy unsuffixed-number)", () => {
    expect(parseRole("coder-retry")).toEqual({
      baseRole: "coder",
      gate: "crash",
      attempt: 1,
    });
    expect(parseRole("coder-vretry")).toEqual({
      baseRole: "coder",
      gate: "verify",
      attempt: 1,
    });
    expect(parseRole("coder-cretry")).toEqual({
      baseRole: "coder",
      gate: "claim",
      attempt: 1,
    });
    expect(parseRole("coder-stretry")).toEqual({
      baseRole: "coder",
      gate: "style",
      attempt: 1,
    });
    expect(parseRole("coder-svretry")).toEqual({
      baseRole: "coder",
      gate: "semantic",
      attempt: 1,
    });
  });

  it("recognizes numbered attempts (≥2)", () => {
    expect(parseRole("coder-vretry2")).toEqual({
      baseRole: "coder",
      gate: "verify",
      attempt: 2,
    });
    expect(parseRole("api-builder-stretry3")).toEqual({
      baseRole: "api-builder",
      gate: "style",
      attempt: 3,
    });
  });

  it("does not strip role-trailing digits that aren't valid attempt numbers", () => {
    // `coder-v2` is NOT a retry — the 2 is part of the role, no suffix match.
    expect(parseRole("coder-v2")).toEqual({
      baseRole: "coder-v2",
      gate: null,
      attempt: 0,
    });
    // 22 is out of [2..MAX_RETRY_PER_GATE] range — restored.
    expect(parseRole("coder-vretry22")).toEqual({
      baseRole: "coder-vretry22",
      gate: null,
      attempt: 0,
    });
  });

  it("matches longest suffix first (svretry before vretry)", () => {
    // `coder-svretry` ends with both `-vretry` and `-svretry`. The latter
    // must win — otherwise we'd parse it as `coder-s` + `verify` gate.
    expect(parseRole("coder-svretry")).toEqual({
      baseRole: "coder",
      gate: "semantic",
      attempt: 1,
    });
  });
});

describe("isAnyRetryRole", () => {
  it("returns true for any retry suffix (numbered or not)", () => {
    expect(isAnyRetryRole("coder-retry")).toBe(true);
    expect(isAnyRetryRole("coder-vretry2")).toBe(true);
    expect(isAnyRetryRole("coder-stretry")).toBe(true);
  });

  it("returns false for base roles", () => {
    expect(isAnyRetryRole("coder")).toBe(false);
    expect(isAnyRetryRole("api-builder")).toBe(false);
    expect(isAnyRetryRole("coder-v2")).toBe(false);
  });
});

describe("nextRetryRole", () => {
  it("attempt 1 emits the unsuffixed-number form (back-compat)", () => {
    expect(nextRetryRole("coder", "verify", 1)).toBe("coder-vretry");
    expect(nextRetryRole("coder", "crash", 1)).toBe("coder-retry");
  });

  it("attempt ≥2 appends the digit", () => {
    expect(nextRetryRole("coder", "verify", 2)).toBe("coder-vretry2");
    expect(nextRetryRole("coder", "style", 3)).toBe("coder-stretry3");
  });
});

describe("maxAttemptsFor", () => {
  it("falls back to default when retry config is missing or empty", () => {
    expect(maxAttemptsFor(undefined, "verify")).toBe(1);
    expect(maxAttemptsFor({}, "style")).toBe(1);
  });

  it("honors operator overrides", () => {
    const retry: AppRetry = { verify: 3, style: 2, crash: 0 };
    expect(maxAttemptsFor(retry, "verify")).toBe(3);
    expect(maxAttemptsFor(retry, "style")).toBe(2);
    expect(maxAttemptsFor(retry, "crash")).toBe(0);
    expect(maxAttemptsFor(retry, "claim")).toBe(1); // unset → default
  });

  it("clamps high values to MAX_RETRY_PER_GATE; rejects negatives → default", () => {
    expect(maxAttemptsFor({ verify: 99 }, "verify")).toBe(MAX_RETRY_PER_GATE);
    // Negative values are treated as "invalid input" → fall back to default
    // (1) rather than disabling the gate. Operators wanting to disable a
    // gate should set it to 0 explicitly.
    expect(maxAttemptsFor({ verify: -3 }, "verify")).toBe(1);
    expect(maxAttemptsFor({ verify: 0 }, "verify")).toBe(0);
  });

  it("falls back to default for non-numeric / NaN input", () => {
    expect(maxAttemptsFor({ verify: NaN as unknown as number }, "verify")).toBe(
      1,
    );
    expect(
      maxAttemptsFor(
        { verify: "many" as unknown as number },
        "verify",
      ),
    ).toBe(1);
  });
});

describe("countRetryAttempts", () => {
  it("counts only same-parent same-baseRole same-gate siblings", () => {
    const meta = {
      runs: [
        baseRun({ role: "coder" }),
        baseRun({ role: "coder-vretry", sessionId: "a" }),
        baseRun({ role: "coder-vretry2", sessionId: "b" }),
        baseRun({ role: "coder-stretry", sessionId: "c" }),
        baseRun({ role: "reviewer-vretry", sessionId: "d" }),
        baseRun({
          role: "coder-vretry",
          sessionId: "e",
          parentSessionId: "DIFFERENT",
        }),
      ],
    };
    expect(countRetryAttempts(meta, PARENT, "coder", "verify")).toBe(2);
    expect(countRetryAttempts(meta, PARENT, "coder", "style")).toBe(1);
    expect(countRetryAttempts(meta, PARENT, "reviewer", "verify")).toBe(1);
  });

  it("preflight gate counts shared `-cretry` slot (claim or preflight)", () => {
    const meta = {
      runs: [
        baseRun({ role: "coder-cretry", sessionId: "a" }),
      ],
    };
    // -cretry is parsed as `claim` gate. Counting against `preflight`
    // gate must include it because the two share the budget slot.
    expect(countRetryAttempts(meta, PARENT, "coder", "preflight")).toBe(1);
    expect(countRetryAttempts(meta, PARENT, "coder", "claim")).toBe(1);
  });

  it("returns 0 when parent is missing", () => {
    expect(
      countRetryAttempts(
        { runs: [baseRun({ role: "coder-vretry" })] },
        null,
        "coder",
        "verify",
      ),
    ).toBe(0);
  });
});

describe("checkEligibility", () => {
  it("rejects runs without a parent (coordinator-level)", () => {
    const r = checkEligibility({
      finishedRun: baseRun({ parentSessionId: null }),
      meta: { runs: [] },
      gate: "verify",
      retry: undefined,
    });
    expect(r.eligible).toBe(false);
    expect(r.reason).toContain("no parent");
  });

  it("rejects cross-gate retries (a -vretry can't trigger a style retry)", () => {
    const r = checkEligibility({
      finishedRun: baseRun({ role: "coder-vretry" }),
      meta: { runs: [] },
      gate: "style",
      retry: undefined,
    });
    expect(r.eligible).toBe(false);
    expect(r.reason).toContain("cross-gate");
  });

  it("allows preflight↔claim cross-flow (shared -cretry slot)", () => {
    // A run that's a -cretry (claim) can still trigger another preflight retry
    // up to the shared budget. With default budget=1, the existing -cretry
    // counts against preflight too — so the second attempt is blocked.
    const r = checkEligibility({
      finishedRun: baseRun({ role: "coder-cretry" }),
      meta: { runs: [] },
      gate: "preflight",
      retry: undefined,
    });
    // Under default budget of 1, the run itself is attempt 1 → no retry.
    expect(r.eligible).toBe(false);
  });

  it("rejects a base run when budget=0 (gate disabled)", () => {
    const r = checkEligibility({
      finishedRun: baseRun({ role: "coder" }),
      meta: { runs: [] },
      gate: "verify",
      retry: { verify: 0 },
    });
    expect(r.eligible).toBe(false);
    expect(r.reason).toContain("disabled");
  });

  it("allows the first verify retry from a base run", () => {
    const r = checkEligibility({
      finishedRun: baseRun({ role: "coder" }),
      meta: { runs: [baseRun({ role: "coder" })] },
      gate: "verify",
      retry: undefined, // default 1
    });
    expect(r.eligible).toBe(true);
    expect(r.nextAttempt).toBe(1);
  });

  it("rejects when default budget is exhausted (already 1 vretry sibling)", () => {
    const r = checkEligibility({
      finishedRun: baseRun({ role: "coder" }),
      meta: {
        runs: [
          baseRun({ role: "coder" }),
          baseRun({ role: "coder-vretry", sessionId: "a" }),
        ],
      },
      gate: "verify",
      retry: undefined,
    });
    expect(r.eligible).toBe(false);
    expect(r.reason).toContain("budget");
  });

  it("allows a 2nd attempt when operator bumped budget to 3", () => {
    const r = checkEligibility({
      finishedRun: baseRun({ role: "coder-vretry" }),
      meta: {
        runs: [
          baseRun({ role: "coder" }),
          baseRun({ role: "coder-vretry", sessionId: "a" }),
        ],
      },
      gate: "verify",
      retry: { verify: 3 },
    });
    expect(r.eligible).toBe(true);
    expect(r.nextAttempt).toBe(2);
  });

  it("allows a 3rd attempt when operator bumped budget to 3", () => {
    const r = checkEligibility({
      finishedRun: baseRun({ role: "coder-vretry2" }),
      meta: {
        runs: [
          baseRun({ role: "coder" }),
          baseRun({ role: "coder-vretry", sessionId: "a" }),
          baseRun({ role: "coder-vretry2", sessionId: "b" }),
        ],
      },
      gate: "verify",
      retry: { verify: 3 },
    });
    expect(r.eligible).toBe(true);
    expect(r.nextAttempt).toBe(3);
  });

  it("rejects past the configured cap", () => {
    const r = checkEligibility({
      finishedRun: baseRun({ role: "coder-vretry2" }),
      meta: {
        runs: [
          baseRun({ role: "coder" }),
          baseRun({ role: "coder-vretry", sessionId: "a" }),
          baseRun({ role: "coder-vretry2", sessionId: "b" }),
        ],
      },
      gate: "verify",
      retry: { verify: 2 },
    });
    expect(r.eligible).toBe(false);
  });

  it("uses the role-derived attempt count when meta is empty (test fixture quirk)", () => {
    // When meta.runs lacks the finishedRun (rare race), the parsed
    // attempt number from the role string still gates the budget.
    const r = checkEligibility({
      finishedRun: baseRun({ role: "coder-vretry" }),
      meta: { runs: [] },
      gate: "verify",
      retry: undefined, // default 1
    });
    expect(r.eligible).toBe(false);
  });

  it("crash-retry siblings don't count toward verify budget (independent)", () => {
    const r = checkEligibility({
      finishedRun: baseRun({ role: "coder" }),
      meta: {
        runs: [
          baseRun({ role: "coder" }),
          baseRun({ role: "coder-retry", sessionId: "x" }),
        ],
      },
      gate: "verify",
      retry: undefined,
    });
    expect(r.eligible).toBe(true);
    expect(r.nextAttempt).toBe(1);
  });
});

describe("strategyForAttempt", () => {
  it("attempt 1 → same-context", () => {
    expect(strategyForAttempt(1)).toBe("same-context");
  });
  it("attempt 2 → fresh-focus", () => {
    expect(strategyForAttempt(2)).toBe("fresh-focus");
  });
  it("attempt 3+ → fixer-only", () => {
    expect(strategyForAttempt(3)).toBe("fixer-only");
    expect(strategyForAttempt(5)).toBe("fixer-only");
  });
});

describe("renderStrategyPrefix", () => {
  it("prints attempt N of M and the chosen strategy name", () => {
    const out = renderStrategyPrefix({ gate: "verify", attempt: 2, maxAttempts: 3 });
    expect(out).toContain("Retry attempt 2 of 3");
    expect(out).toContain("verify");
    expect(out).toContain("fresh-focus");
  });

  it("attempt 1 surface uses same-context framing", () => {
    const out = renderStrategyPrefix({ gate: "crash", attempt: 1, maxAttempts: 1 });
    expect(out).toContain("same-context");
  });

  it("final attempt uses fixer-only directive", () => {
    const out = renderStrategyPrefix({ gate: "style", attempt: 3, maxAttempts: 3 });
    expect(out).toContain("Final attempt");
    expect(out).toContain("fixer-only");
  });
});

describe("describeRetry", () => {
  it("formats the gate label with attempt fraction", () => {
    expect(describeRetry("verify", 2, 3)).toBe("verify retry 2/3");
    expect(describeRetry("crash", 1, 1)).toBe("crash retry 1/1");
  });
});

describe("totalCapFor", () => {
  it("returns default when retry config is undefined", () => {
    expect(totalCapFor(undefined)).toBe(DEFAULT_MAX_RETRIES_PER_TASK);
  });
  it("returns default when totalCap field is absent", () => {
    expect(totalCapFor({ verify: 2 })).toBe(DEFAULT_MAX_RETRIES_PER_TASK);
  });
  it("respects an explicit totalCap override", () => {
    expect(totalCapFor({ totalCap: 6 })).toBe(6);
    expect(totalCapFor({ totalCap: 0 })).toBe(0); // 0 disables cap
  });
  it("ignores invalid totalCap (negative, NaN)", () => {
    expect(totalCapFor({ totalCap: -3 })).toBe(DEFAULT_MAX_RETRIES_PER_TASK);
    expect(totalCapFor({ totalCap: Number.NaN })).toBe(DEFAULT_MAX_RETRIES_PER_TASK);
  });
});

describe("totalRetriesInTask", () => {
  it("returns 0 for a task with no retries fired", () => {
    expect(totalRetriesInTask({ runs: [baseRun(), baseRun({ sessionId: "x" })] })).toBe(0);
  });
  it("sums retryAttempt across runs", () => {
    const runs: Run[] = [
      baseRun({ role: "coder-vretry", retryAttempt: 1 }),
      baseRun({ sessionId: "b", role: "fixer-cretry2", retryAttempt: 2 }),
      baseRun({ sessionId: "c" }), // base run, no retryAttempt
    ];
    expect(totalRetriesInTask({ runs })).toBe(3);
  });
  it("ignores invalid retryAttempt values", () => {
    const runs: Run[] = [
      baseRun({ retryAttempt: -1 }),
      baseRun({ sessionId: "b", retryAttempt: Number.NaN }),
      baseRun({ sessionId: "c", retryAttempt: 2 }),
    ];
    expect(totalRetriesInTask({ runs })).toBe(2);
  });
});

describe("checkEligibility — per-task ceiling", () => {
  it("blocks retry when total cap already reached", () => {
    // 4 retries already fired across siblings → at the default cap.
    const runs: Run[] = [
      baseRun({ sessionId: "a", role: "coder-vretry2", retryAttempt: 2 }),
      baseRun({ sessionId: "b", role: "fixer-cretry2", retryAttempt: 2 }),
    ];
    const finishedRun = baseRun({
      sessionId: "c",
      role: "reviewer",
    });
    const res = checkEligibility({
      finishedRun,
      meta: { runs: [...runs, finishedRun] },
      gate: "crash",
      retry: undefined, // default cap = 4
    });
    expect(res.eligible).toBe(false);
    expect(res.reason).toContain("per-task ceiling");
    expect(res.reason).toContain("4/4");
  });

  it("allows retry when total is below cap", () => {
    const runs: Run[] = [
      baseRun({ sessionId: "a", role: "coder-vretry", retryAttempt: 1 }),
    ];
    const finishedRun = baseRun({ sessionId: "b", role: "fixer" });
    const res = checkEligibility({
      finishedRun,
      meta: { runs: [...runs, finishedRun] },
      gate: "crash",
      retry: undefined,
    });
    expect(res.eligible).toBe(true);
  });

  it("respects totalCap=0 (cap disabled)", () => {
    // 100 retries fired but cap disabled → eligibility falls through to
    // per-gate budget.
    const runs: Run[] = Array.from({ length: 50 }, (_, i) =>
      baseRun({ sessionId: `s${i}`, role: "coder-vretry2", retryAttempt: 2 }),
    );
    const finishedRun = baseRun({ sessionId: "z", role: "fixer" });
    const res = checkEligibility({
      finishedRun,
      meta: { runs: [...runs, finishedRun] },
      gate: "crash",
      retry: { totalCap: 0 },
    });
    expect(res.eligible).toBe(true);
  });

  it("respects an explicit higher totalCap", () => {
    const runs: Run[] = Array.from({ length: 5 }, (_, i) =>
      baseRun({ sessionId: `s${i}`, role: "coder-vretry", retryAttempt: 1 }),
    );
    const finishedRun = baseRun({ sessionId: "z", role: "fixer" });
    const res = checkEligibility({
      finishedRun,
      meta: { runs: [...runs, finishedRun] },
      gate: "crash",
      retry: { totalCap: 8 }, // 5 < 8 → eligible
    });
    expect(res.eligible).toBe(true);
  });
});
