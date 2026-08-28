import { describe, it, expect } from "vitest";
import {
  CLAIM_RETRY_SUFFIX,
  deriveVerdict,
  isEligibleForClaimRetry,
  parseChangedFiles,
  parsePorcelainV1,
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

  describe("the (none) sentinel", () => {
    const spellings = [
      "(none)",
      "(none — analysis only)",
      "- (none — analysis only)",
      "* (none)",
      "_(none)_",
      "- _(none)_",
      "- (NONE)",
    ];
    for (const spelling of spellings) {
      it(`treats ${JSON.stringify(spelling)} as no files`, () => {
        const md = [
          "## Changed files",
          spelling,
          "",
          "## How to verify",
        ].join("\n");
        expect(parseChangedFiles(md)).toEqual([]);
      });
    }

    it("lets the sentinel win over a real path listed above it", () => {
      const md = [
        "## Changed files",
        "- `src/foo.ts` — edited",
        "- (none — analysis only)",
      ].join("\n");
      expect(parseChangedFiles(md)).toEqual([]);
    });

    it("lets the sentinel win over a real path listed below it", () => {
      const md = [
        "## Changed files",
        "- (none — analysis only)",
        "- `src/foo.ts` — edited",
      ].join("\n");
      expect(parseChangedFiles(md)).toEqual([]);
    });
  });

  describe("bare paths containing hyphens", () => {
    it("keeps a hyphen inside a bare filename", () => {
      const md = ["## Changed files", "- my-file.ts"].join("\n");
      expect(parseChangedFiles(md)).toEqual(["my-file.ts"]);
    });

    it("keeps hyphens inside a bare path with an em-dash description", () => {
      const md = [
        "## Changed files",
        "- src/some-module/index.ts — refactored",
      ].join("\n");
      expect(parseChangedFiles(md)).toEqual(["src/some-module/index.ts"]);
    });

    it("terminates on an en dash separator", () => {
      const md = [
        "## Changed files",
        "- src/some-module/index.ts – refactored",
      ].join("\n");
      expect(parseChangedFiles(md)).toEqual(["src/some-module/index.ts"]);
    });

    it("terminates on an em dash with no surrounding spaces", () => {
      const md = ["## Changed files", "- my-file.ts—refactored"].join("\n");
      expect(parseChangedFiles(md)).toEqual(["my-file.ts"]);
    });

    it("terminates on a spaced ASCII hyphen used as a separator", () => {
      const md = ["## Changed files", "- foo.ts - notes"].join("\n");
      expect(parseChangedFiles(md)).toEqual(["foo.ts"]);
    });

    it("keeps hyphens in an asterisk-bulleted bare path", () => {
      const md = ["## Changed files", "* libs/retry-ladder.ts — tweak"].join("\n");
      expect(parseChangedFiles(md)).toEqual(["libs/retry-ladder.ts"]);
    });
  });

  it("still extracts a backticked path with an em-dash description", () => {
    const md = ["## Changed files", "- `libs/verifier.ts` — fixed"].join("\n");
    expect(parseChangedFiles(md)).toEqual(["libs/verifier.ts"]);
  });

  describe("the non-path guard", () => {
    it("drops a token that opens with a parenthesis", () => {
      const md = ["## Changed files", "- (no files were touched)"].join("\n");
      expect(parseChangedFiles(md)).toEqual([]);
    });

    it("keeps real paths on the lines around a dropped token", () => {
      const md = [
        "## Changed files",
        "- (no files were touched)",
        "- src/real-file.ts — edited",
      ].join("\n");
      expect(parseChangedFiles(md)).toEqual(["src/real-file.ts"]);
    });

    it("still returns [] for the bulleted (none) sentinel", () => {
      const md = ["## Changed files", "- (none — analysis only)"].join("\n");
      expect(parseChangedFiles(md)).toEqual([]);
    });
  });

  describe("extension-less root files", () => {
    const names = ["Makefile", "Dockerfile", "LICENSE", "CODEOWNERS"];

    for (const name of names) {
      it(`keeps a backticked \`${name}\``, () => {
        const md = ["## Changed files", `- \`${name}\` — edited`].join("\n");
        expect(parseChangedFiles(md)).toEqual([name]);
      });

      it(`keeps a bare ${name}`, () => {
        const md = ["## Changed files", `- ${name} — edited`].join("\n");
        expect(parseChangedFiles(md)).toEqual([name]);
      });
    }
  });

  describe("a bullet that is a sentence, not a claim", () => {
    it("drops the first word of `- no changes`", () => {
      const md = ["## Changed files", "- no changes"].join("\n");
      expect(parseChangedFiles(md)).toEqual([]);
    });

    it("drops the first word of a sentence that references a backticked file", () => {
      const md = [
        "## Changed files",
        "- see `note.md` for details",
      ].join("\n");
      expect(parseChangedFiles(md)).toEqual([]);
    });

    it("drops `- nothing was touched in this repo`", () => {
      const md = ["## Changed files", "- nothing was touched in this repo"].join("\n");
      expect(parseChangedFiles(md)).toEqual([]);
    });

    it("keeps real paths on the lines around a dropped sentence", () => {
      const md = [
        "## Changed files",
        "- no changes",
        "- src/real-file.ts — edited",
        "- see `note.md` for details",
      ].join("\n");
      expect(parseChangedFiles(md)).toEqual(["src/real-file.ts"]);
    });

    it("lets a prose-only section read as analysis-only rather than a claim", () => {
      const md = [
        "## Changed files",
        "- no changes",
        "",
        "## How to verify",
      ].join("\n");
      const claimed = parseChangedFiles(md);
      expect(claimed).toEqual([]);
      expect(deriveVerdict({ claimed, actual: [] }).verdict).toBe("pass");
    });
  });

  describe("tokens carrying a path signal are untouched by the sentence rule", () => {
    const survivors: Array<[string, string]> = [
      ["- src/a-b/c.ts", "src/a-b/c.ts"],
      ["- my-file.ts", "my-file.ts"],
      ["- .gitignore", ".gitignore"],
      ["- .gitignore — added a rule", ".gitignore"],
      ["- bin/run", "bin/run"],
      ["- bin/run — made it executable", "bin/run"],
      ["- .github/CODEOWNERS", ".github/CODEOWNERS"],
      ["- scripts/deploy — rewrote it", "scripts/deploy"],
      ["- src/foo.ts added a helper", "src/foo.ts"],
      ["- src/foo.ts (added a helper)", "src/foo.ts"],
    ];

    for (const [line, expected] of survivors) {
      it(`keeps ${JSON.stringify(expected)} from ${JSON.stringify(line)}`, () => {
        expect(parseChangedFiles(["## Changed files", line].join("\n"))).toEqual([
          expected,
        ]);
      });
    }
  });

  describe("extension-less names keep every separator style", () => {
    const names = ["Makefile", "Dockerfile", "LICENSE", "CODEOWNERS"];
    const tails = ["", " — edited", " – edited", " - edited", " (edited)", " [edited]", ": edited"];

    for (const name of names) {
      for (const tail of tails) {
        it(`keeps ${JSON.stringify(`- ${name}${tail}`)}`, () => {
          const md = ["## Changed files", `- ${name}${tail}`].join("\n");
          expect(parseChangedFiles(md)).toEqual([name]);
        });
      }
    }
  });

  describe("stated false negative of the sentence rule", () => {
    it("drops an extension-less name whose description has no separator", () => {
      const md = ["## Changed files", "- Dockerfile updated the base image"].join("\n");
      expect(parseChangedFiles(md)).toEqual([]);
    });

    it("keeps that same name once any separator is present", () => {
      const md = ["## Changed files", "- Dockerfile — updated the base image"].join("\n");
      expect(parseChangedFiles(md)).toEqual(["Dockerfile"]);
    });

    it("keeps that same name once it is backticked", () => {
      const md = ["## Changed files", "- `Dockerfile` updated the base image"].join("\n");
      expect(parseChangedFiles(md)).toEqual(["Dockerfile"]);
    });
  });

  describe("stated false positive — a lone prose token is not separable from a filename", () => {
    it("still claims N/A", () => {
      expect(parseChangedFiles(["## Changed files", "- N/A"].join("\n"))).toEqual(["N/A"]);
    });

    it("still claims None", () => {
      expect(parseChangedFiles(["## Changed files", "- None"].join("\n"))).toEqual(["None"]);
    });

    it("still claims a backticked prose token", () => {
      expect(parseChangedFiles(["## Changed files", "- `no changes`"].join("\n"))).toEqual([
        "no changes",
      ]);
    });
  });
});

describe("parsePorcelainV1", () => {
  describe("the exact bytes git status --porcelain=v1 emits", () => {
    const table: Array<[string, string]> = [
      [" M math.ts", "math.ts"],
      [" D old.ts", "old.ts"],
      [" M src/a-b/c.ts", "src/a-b/c.ts"],
      ["?? new.ts", "new.ts"],
      ["M  staged.ts", "staged.ts"],
      ["A  added.ts", "added.ts"],
      ["MM both.ts", "both.ts"],
      ["R  old.ts -> new.ts", "new.ts"],
    ];

    for (const [line, expected] of table) {
      it(`parses ${JSON.stringify(line)} as ${JSON.stringify(expected)}`, () => {
        expect(parsePorcelainV1(line)).toEqual([expected]);
      });
    }
  });

  describe("the unstaged prefix that the leading-trim used to eat", () => {
    it("keeps the path bare for a worktree-only modification", () => {
      expect(parsePorcelainV1(" M math.ts")).toEqual(["math.ts"]);
    });

    it("keeps the path bare for a worktree-only deletion", () => {
      expect(parsePorcelainV1(" D old.ts")).toEqual(["old.ts"]);
    });

    it("keeps the path bare for a worktree-only type change", () => {
      expect(parsePorcelainV1(" T link.ts")).toEqual(["link.ts"]);
    });

    it("keeps the path bare for a nested unstaged path", () => {
      expect(parsePorcelainV1(" M libs/__tests__/verifier.test.ts")).toEqual([
        "libs/__tests__/verifier.test.ts",
      ]);
    });
  });

  describe("multi-line output", () => {
    it("parses a realistic mixed worktree", () => {
      const stdout = [
        " M libs/verifier.ts",
        "M  libs/meta.ts",
        "?? scratch.md",
        " D dead.ts",
        "",
      ].join("\n");
      expect(parsePorcelainV1(stdout)).toEqual([
        "libs/verifier.ts",
        "libs/meta.ts",
        "scratch.md",
        "dead.ts",
      ]);
    });

    it("handles CRLF line endings", () => {
      expect(parsePorcelainV1(" M a.ts\r\n M b.ts\r\n")).toEqual(["a.ts", "b.ts"]);
    });

    it("strips a bare trailing carriage return on the last line", () => {
      expect(parsePorcelainV1(" M math.ts\r")).toEqual(["math.ts"]);
    });

    it("dedupes a repeated path", () => {
      expect(parsePorcelainV1(" M a.ts\nM  a.ts")).toEqual(["a.ts"]);
    });

    it("returns an empty list for empty stdout", () => {
      expect(parsePorcelainV1("")).toEqual([]);
      expect(parsePorcelainV1("\n")).toEqual([]);
    });
  });

  describe("paths containing spaces", () => {
    it("keeps a space inside an unstaged path", () => {
      expect(parsePorcelainV1(" M my file.ts")).toEqual(["my file.ts"]);
    });

    it("keeps a space inside a staged path", () => {
      expect(parsePorcelainV1("A  src/my dir/my file.ts")).toEqual([
        "src/my dir/my file.ts",
      ]);
    });

    it("keeps trailing content after multiple spaces", () => {
      expect(parsePorcelainV1("?? a  b.ts")).toEqual(["a  b.ts"]);
    });
  });

  describe("renames", () => {
    it("yields the new path for a staged rename", () => {
      expect(parsePorcelainV1("R  old.ts -> new.ts")).toEqual(["new.ts"]);
    });

    it("yields the new path for a rename with a further worktree edit", () => {
      expect(parsePorcelainV1("RM old.ts -> new.ts")).toEqual(["new.ts"]);
    });

    it("yields the new path for a copy", () => {
      expect(parsePorcelainV1("C  src.ts -> copy.ts")).toEqual(["copy.ts"]);
    });

    it("does not split a non-rename path that happens to contain an arrow", () => {
      expect(parsePorcelainV1(" M a -> b.ts")).toEqual(["a -> b.ts"]);
    });
  });

  describe("C-style quoted paths", () => {
    it("unwraps a plainly quoted path", () => {
      expect(parsePorcelainV1(' M "quoted.ts"')).toEqual(["quoted.ts"]);
    });

    it("decodes octal escapes back into UTF-8", () => {
      expect(parsePorcelainV1(' M "\\303\\251t\\303\\251.ts"')).toEqual(["été.ts"]);
    });

    it("decodes an escaped double quote", () => {
      expect(parsePorcelainV1(' M "we\\"ird.ts"')).toEqual(['we"ird.ts']);
    });

    it("decodes an escaped backslash", () => {
      expect(parsePorcelainV1(' M "back\\\\slash.ts"')).toEqual(["back\\slash.ts"]);
    });

    it("unwraps both sides of a quoted rename and yields the new path", () => {
      expect(parsePorcelainV1('R  "old name.ts" -> "new name.ts"')).toEqual([
        "new name.ts",
      ]);
    });

    it("leaves an unquoted path with an inner quote character alone", () => {
      expect(parsePorcelainV1(" M a\"b.ts")).toEqual(['a"b.ts']);
    });
  });

  describe("bytes captured verbatim from a live git status --porcelain=v1", () => {
    const stdout = [
      " M math.ts",
      ' M "my file.ts"',
      " D old.ts",
      "R  ren.ts -> renamed.ts",
      " M src/a-b/c.ts",
      "A  staged.ts",
      '?? "na\\303\\257ve dir.ts"',
      "?? new.ts",
      '?? "\\303\\251t\\303\\251.ts"',
      "",
    ].join("\n");

    it("reduces every line to a bare path", () => {
      expect(parsePorcelainV1(stdout)).toEqual([
        "math.ts",
        "my file.ts",
        "old.ts",
        "renamed.ts",
        "src/a-b/c.ts",
        "staged.ts",
        "naïve dir.ts",
        "new.ts",
        "été.ts",
      ]);
    });

    it("leaves no status prefix or quote character behind", () => {
      for (const path of parsePorcelainV1(stdout)) {
        expect(path).not.toMatch(/^[ MTADRCU?!]{2} /);
        expect(path).not.toContain('"');
        expect(path).not.toContain("\\3");
      }
    });
  });

  describe("lines that do not match the contract", () => {
    const rejected = [
      "",
      "M",
      " M",
      "MM ",
      "garbage",
      "   spaces-only-flags.ts",
      "XY bad.ts",
      "M\tno-space.ts",
    ];

    for (const line of rejected) {
      it(`skips ${JSON.stringify(line)}`, () => {
        expect(parsePorcelainV1(line)).toEqual([]);
      });
    }

    it("keeps parsing valid lines around a garbage line", () => {
      expect(parsePorcelainV1(" M a.ts\ngarbage\n M b.ts")).toEqual(["a.ts", "b.ts"]);
    });
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
    expect(v.unclaimedActual).toEqual([]);
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

  it("passes an analysis-only report whose sentinel is bulleted", () => {
    const md = [
      "# semantic-verifier @ app-web",
      "",
      "## Changed files",
      "- (none — analysis only)",
      "",
      "## How to verify",
      "Nothing to run.",
    ].join("\n");
    const claimed = parseChangedFiles(md);
    expect(claimed).toEqual([]);
    const v = deriveVerdict({ claimed, actual: [] });
    expect(v.verdict).toBe("pass");
    expect(v.reason).toBe("analysis-only run — no diff, no claims, nothing to verify");
  });

  it("passes a report whose only claim is an extension-less root file", () => {
    const md = [
      "# coder @ app-web",
      "",
      "## Changed files",
      "- `Makefile` — added the lint target",
      "",
      "## How to verify",
      "Run make lint.",
    ].join("\n");
    const claimed = parseChangedFiles(md);
    expect(claimed).toEqual(["Makefile"]);
    const v = deriveVerdict({ claimed, actual: ["Makefile"] });
    expect(v.verdict).toBe("pass");
    expect(v.unmatchedClaims).toEqual([]);
  });

  describe("the E2E run 3 scenario (unstaged coder edit)", () => {
    it("passes a claim of math.ts against a worktree-only status line", () => {
      const md = [
        "# coder @ app-web",
        "",
        "## Changed files",
        "- `math.ts` — added subtract",
        "",
        "## How to verify",
        "Run the tests.",
      ].join("\n");
      const claimed = parseChangedFiles(md);
      const actual = parsePorcelainV1(" M math.ts");
      expect(claimed).toEqual(["math.ts"]);
      expect(actual).toEqual(["math.ts"]);

      const v = deriveVerdict({ claimed, actual });
      expect(v.verdict).toBe("pass");
      expect(v.unmatchedClaims).toEqual([]);
      expect(v.unclaimedActual).toEqual([]);
    });

    it("still reports drift when the claim genuinely is not in the worktree", () => {
      const v = deriveVerdict({
        claimed: ["math.ts", "ghost.ts"],
        actual: parsePorcelainV1(" M math.ts"),
      });
      expect(v.verdict).toBe("drift");
      expect(v.unmatchedClaims).toEqual(["ghost.ts"]);
    });
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
