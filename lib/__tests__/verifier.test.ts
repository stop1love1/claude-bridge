import { describe, it, expect } from "vitest";
import {
  CLAIM_RETRY_SUFFIX,
  deriveVerdict,
  isEligibleForClaimRetry,
  parseChangedFiles,
  renderClaimRetryContextBlock,
} from "../verifier";
import type { Run, RunVerifier } from "../meta";

describe("parseChangedFiles", () => {
  it("returns empty list when no Changed files section is present", () => {
    expect(parseChangedFiles("# Report\n\n## Summary\nDid stuff.")).toEqual([]);
  });

  it("extracts backtick-wrapped paths with descriptions", () => {
    const md = [
      "# coder @ app-web",
      "",
      "## Changed files",
      "- `src/foo.ts` — added new helper",
      "- `src/bar.tsx` — refactored render",
      "",
      "## How to verify",
      "Run tests.",
    ].join("\n");
    expect(parseChangedFiles(md)).toEqual(["src/foo.ts", "src/bar.tsx"]);
  });

  it("accepts asterisk bullets and bare paths", () => {
    const md = [
      "## Changed files",
      "* lib/utils.ts — tweak",
      "* `lib/x.ts`",
    ].join("\n");
    expect(parseChangedFiles(md)).toEqual(["lib/utils.ts", "lib/x.ts"]);
  });

  it("treats the analysis-only placeholder as empty", () => {
    const md = [
      "## Changed files",
      "(none — analysis only)",
      "",
      "## How to verify",
    ].join("\n");
    expect(parseChangedFiles(md)).toEqual([]);
  });

  it("stops at the next H2 boundary", () => {
    const md = [
      "## Changed files",
      "- `a.ts` — first",
      "",
      "## Risks / out-of-scope",
      "- `b.ts` — should NOT be picked up",
    ].join("\n");
    expect(parseChangedFiles(md)).toEqual(["a.ts"]);
  });

  it("dedupes repeated paths", () => {
    const md = [
      "## Changed files",
      "- `dup.ts` — once",
      "- `dup.ts` — again (mistake)",
    ].join("\n");
    expect(parseChangedFiles(md)).toEqual(["dup.ts"]);
  });
});

describe("deriveVerdict", () => {
  it("returns pass for analysis-only run (both empty)", () => {
    const v = deriveVerdict({ claimed: [], actual: [] });
    expect(v.verdict).toBe("pass");
    expect(v.unmatchedClaims).toEqual([]);
    expect(v.unclaimedActual).toEqual([]);
    expect(v.reason).toContain("analysis-only");
  });

  it("returns pass when every claim is in the diff", () => {
    const v = deriveVerdict({
      claimed: ["src/foo.ts", "src/bar.tsx"],
      actual: ["src/foo.ts", "src/bar.tsx"],
    });
    expect(v.verdict).toBe("pass");
    expect(v.unmatchedClaims).toEqual([]);
  });

  it("returns pass + surfaces extras as informational, not failure", () => {
    const v = deriveVerdict({
      claimed: ["src/foo.ts"],
      actual: ["src/foo.ts", "src/baz.ts"],
    });
    expect(v.verdict).toBe("pass");
    expect(v.unclaimedActual).toEqual(["src/baz.ts"]);
  });

  it("returns broken when claims exist but diff is empty", () => {
    const v = deriveVerdict({
      claimed: ["src/foo.ts"],
      actual: [],
    });
    expect(v.verdict).toBe("broken");
    expect(v.reason).toContain("hallucinated");
  });

  it("returns broken when no claims but diff has changes", () => {
    const v = deriveVerdict({
      claimed: [],
      actual: ["src/foo.ts"],
    });
    expect(v.verdict).toBe("broken");
    expect(v.reason).toContain("silent edits");
  });

  it("returns drift when at least one claim is missing from diff", () => {
    const v = deriveVerdict({
      claimed: ["src/foo.ts", "src/missing.ts"],
      actual: ["src/foo.ts"],
    });
    expect(v.verdict).toBe("drift");
    expect(v.unmatchedClaims).toEqual(["src/missing.ts"]);
  });

  it("ignores lockfile churn when computing unclaimed-actual", () => {
    const v = deriveVerdict({
      claimed: ["src/foo.ts"],
      actual: ["src/foo.ts", "bun.lock", "package-lock.json"],
    });
    expect(v.verdict).toBe("pass");
    expect(v.unclaimedActual).toEqual([]); // lock files filtered out
  });

  it("normalizes Windows-style backslashes in paths before comparison", () => {
    const v = deriveVerdict({
      claimed: ["src\\foo.ts"],
      actual: ["src/foo.ts"],
    });
    expect(v.verdict).toBe("pass");
  });

  it("strips a leading ./ before comparison", () => {
    const v = deriveVerdict({
      claimed: ["./src/foo.ts"],
      actual: ["src/foo.ts"],
    });
    expect(v.verdict).toBe("pass");
  });
});

describe("renderClaimRetryContextBlock", () => {
  it("renders the verdict heading + reason + both mismatch lists", () => {
    const v: RunVerifier = {
      verdict: "drift",
      reason: "1 claimed file(s) not present in git diff",
      claimedFiles: ["src/foo.ts", "src/missing.ts"],
      actualFiles: ["src/foo.ts", "src/extra.ts"],
      unmatchedClaims: ["src/missing.ts"],
      unclaimedActual: ["src/extra.ts"],
      durationMs: 50,
    };
    const out = renderClaimRetryContextBlock(v);
    expect(out).toContain("## Auto-retry context — what failed last time");
    expect(out).toContain("Verdict: DRIFT");
    expect(out).toContain("not present in git diff");
    expect(out).toContain("- `src/missing.ts`");
    expect(out).toContain("- `src/extra.ts`");
  });

  it("omits the unmatched-claims section when there are none", () => {
    const v: RunVerifier = {
      verdict: "broken",
      reason: "agent reported 'no changes' but git diff shows ...",
      claimedFiles: [],
      actualFiles: ["src/x.ts"],
      unmatchedClaims: [],
      unclaimedActual: ["src/x.ts"],
      durationMs: 10,
    };
    const out = renderClaimRetryContextBlock(v);
    expect(out).not.toContain("CLAIMED to change but the diff doesn't show");
    expect(out).toContain("in the diff but NOT in your `## Changed files`");
  });

  it("omits the unclaimed-actual section when there are none", () => {
    const v: RunVerifier = {
      verdict: "broken",
      reason: "agent claimed N file change(s) but git diff is empty",
      claimedFiles: ["src/x.ts"],
      actualFiles: [],
      unmatchedClaims: ["src/x.ts"],
      unclaimedActual: [],
      durationMs: 10,
    };
    const out = renderClaimRetryContextBlock(v);
    expect(out).toContain("CLAIMED to change but the diff doesn't show");
    expect(out).not.toContain("in the diff but NOT in your");
  });
});

describe("isEligibleForClaimRetry", () => {
  const baseRun: Run = {
    sessionId: "11111111-1111-1111-1111-111111111111",
    role: "coder",
    repo: "app-web",
    status: "done",
    startedAt: null,
    endedAt: null,
    parentSessionId: "00000000-0000-0000-0000-000000000000",
  };

  it("rejects when no parent session", () => {
    expect(
      isEligibleForClaimRetry({
        finishedRun: { ...baseRun, parentSessionId: null },
        meta: { runs: [] },
      }),
    ).toBe(false);
  });

  it("rejects when role is already a retry of any flavour", () => {
    for (const role of ["coder-retry", "coder-vretry", "coder-cretry"]) {
      expect(
        isEligibleForClaimRetry({
          finishedRun: { ...baseRun, role },
          meta: { runs: [] },
        }),
      ).toBe(false);
    }
  });

  it("rejects when a -cretry sibling already exists for same parent+role", () => {
    const sibling: Run = {
      ...baseRun,
      sessionId: "22222222-2222-2222-2222-222222222222",
      role: "coder-cretry",
    };
    expect(
      isEligibleForClaimRetry({
        finishedRun: baseRun,
        meta: { runs: [baseRun, sibling] },
      }),
    ).toBe(false);
  });

  it("allows even when -retry / -vretry siblings exist (independent budgets)", () => {
    const crashRetry: Run = { ...baseRun, sessionId: "33333333-3333-3333-3333-333333333333", role: "coder-retry" };
    const verifyRetry: Run = { ...baseRun, sessionId: "44444444-4444-4444-4444-444444444444", role: "coder-vretry" };
    expect(
      isEligibleForClaimRetry({
        finishedRun: baseRun,
        meta: { runs: [baseRun, crashRetry, verifyRetry] },
      }),
    ).toBe(true);
  });

  it("CLAIM_RETRY_SUFFIX is the literal -cretry", () => {
    expect(CLAIM_RETRY_SUFFIX).toBe("-cretry");
  });
});
