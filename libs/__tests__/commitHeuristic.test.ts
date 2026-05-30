import { describe, it, expect } from "vitest";
import {
  buildHeuristicMessage,
  deriveScope,
  parseNameStatus,
  type NameStatusLine,
} from "../commitHeuristic";

describe("parseNameStatus", () => {
  it("parses plain statuses", () => {
    const rows = parseNameStatus("M\tsrc/a.ts\nA\tsrc/b.ts\nD\tsrc/c.ts");
    expect(rows).toEqual([
      { status: "M", path: "src/a.ts" },
      { status: "A", path: "src/b.ts" },
      { status: "D", path: "src/c.ts" },
    ]);
  });

  it("parses a rename with old + new path", () => {
    const rows = parseNameStatus("R100\told/x.ts\tnew/y.ts");
    expect(rows).toEqual([{ status: "R", oldPath: "old/x.ts", path: "new/y.ts" }]);
  });

  it("ignores blank lines and unknown statuses", () => {
    const rows = parseNameStatus("\nM\tkeep.ts\nU\tunmerged.ts\n");
    expect(rows).toEqual([{ status: "M", path: "keep.ts" }]);
  });
});

describe("deriveScope", () => {
  it("returns the deepest shared non-generic dir", () => {
    expect(deriveScope(["app/_components/SessionLog/views.tsx", "app/_components/SessionLog/helpers.ts"]))
      .toBe("SessionLog");
  });

  it("skips generic top-levels", () => {
    expect(deriveScope(["src/auth/login.ts", "src/auth/token.ts"])).toBe("auth");
  });

  it("returns empty when files span unrelated areas", () => {
    expect(deriveScope(["a/x.ts", "b/y.ts"])).toBe("");
  });

  it("returns empty for a single top-level file", () => {
    expect(deriveScope(["README.md"])).toBe("");
  });
});

describe("buildHeuristicMessage", () => {
  it("returns the no-changes sentinel for an empty set", () => {
    expect(buildHeuristicMessage([])).toBe("chore: no changes");
  });

  it("names a single file in the subject", () => {
    const rows: NameStatusLine[] = [{ status: "M", path: "libs/auth/token.ts" }];
    const msg = buildHeuristicMessage(rows);
    expect(msg.split("\n")[0]).toBe("fix(auth): update token.ts");
  });

  it("picks feat when only additions, with a scope", () => {
    const rows: NameStatusLine[] = [
      { status: "A", path: "libs/finance/a.ts" },
      { status: "A", path: "libs/finance/b.ts" },
    ];
    expect(buildHeuristicMessage(rows).split("\n")[0]).toBe("feat(finance): add 2 files");
  });

  it("caps the body bullet list and summarizes overflow", () => {
    const rows: NameStatusLine[] = Array.from({ length: 12 }, (_, i) => ({
      status: "M" as const,
      path: `pkg/x${i}.ts`,
    }));
    const body = buildHeuristicMessage(rows).split("\n").slice(2);
    expect(body.filter((l) => l.startsWith("- ")).length).toBe(9); // 8 shown + overflow line
    expect(body[body.length - 1]).toBe("- …and 4 more");
  });

  it("renders renames with the old → new arrow", () => {
    const rows: NameStatusLine[] = [{ status: "R", oldPath: "a/old.ts", path: "a/new.ts" }];
    expect(buildHeuristicMessage(rows)).toContain("- rename a/old.ts → a/new.ts");
  });
});
