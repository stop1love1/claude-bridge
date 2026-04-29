import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { __test, attachReferences } from "../contextAttach";
import type { SymbolEntry, SymbolIndex } from "../symbolIndex";

function mktmp(label: string): string {
  return mkdtempSync(join(tmpdir(), `bridge-attach-${label}-`));
}

function writeFile(root: string, rel: string, content: string): void {
  const abs = join(root, rel);
  mkdirSync(abs.replace(/[\\/][^\\/]+$/, ""), { recursive: true });
  writeFileSync(abs, content, "utf8");
}

describe("__test.tokenize", () => {
  it("lowercases, splits on non-alphanum, drops short/stopword/numeric", () => {
    const out = __test.tokenize(
      "Add a /users/me endpoint that returns the user profile. Use Express 4.",
    );
    expect(out).toContain("users");
    expect(out).toContain("endpoint");
    expect(out).toContain("returns");
    expect(out).toContain("user");
    expect(out).toContain("profile");
    expect(out).toContain("express");
    expect(out).not.toContain("the"); // stopword
    expect(out).not.toContain("a"); // too short
    expect(out).not.toContain("4"); // numeric
    expect(out).not.toContain("add"); // stopword (in our list)
  });

  it("returns empty for an empty string", () => {
    expect(__test.tokenize("")).toEqual([]);
  });

  it("dedupes repeated tokens", () => {
    const out = __test.tokenize("form Form FORM forms");
    expect(out.filter((t) => t === "form").length).toBe(1);
  });
});

describe("__test.scoreSymbol", () => {
  const sym: SymbolEntry = {
    name: "useFormState",
    kind: "function",
    file: "hooks/forms/useFormState.ts",
    signature: "() => FormState",
  };

  it("counts substring matches in file path + symbol name", () => {
    expect(__test.scoreSymbol(sym, ["form"])).toBe(1); // matches both name and file, but counted as one token = +1
    expect(__test.scoreSymbol(sym, ["form", "state"])).toBe(2);
    expect(__test.scoreSymbol(sym, ["unrelated"])).toBe(0);
  });

  it("substring (not whole-word) — useFormState matches `form`", () => {
    expect(
      __test.scoreSymbol(
        { name: "useFormState", kind: "function", file: "x.ts", signature: "" },
        ["form"],
      ),
    ).toBeGreaterThan(0);
  });
});

describe("__test.pickCandidateFiles", () => {
  const symbols: SymbolEntry[] = [
    { name: "useFormState", kind: "function", file: "hooks/useFormState.ts", signature: "" },
    { name: "validateForm", kind: "function", file: "hooks/useFormState.ts", signature: "" },
    { name: "Avatar", kind: "component", file: "components/Avatar.tsx", signature: "" },
    { name: "cn", kind: "function", file: "lib/cn.ts", signature: "" },
  ];

  it("aggregates symbol scores per file, descending order", () => {
    const got = __test.pickCandidateFiles(symbols, ["form", "state"]);
    expect(got[0]?.file).toBe("hooks/useFormState.ts");
    expect(got[0]?.score).toBeGreaterThanOrEqual(__test.MIN_SCORE);
    // Avatar / cn shouldn't make the cut for "form state" tokens.
    expect(got.find((c) => c.file === "components/Avatar.tsx")).toBeUndefined();
  });

  it("returns [] when no symbol scores above MIN_SCORE", () => {
    const got = __test.pickCandidateFiles(symbols, ["totallyunrelatedword"]);
    expect(got).toEqual([]);
  });

  it("returns [] when token list is empty", () => {
    expect(__test.pickCandidateFiles(symbols, [])).toEqual([]);
  });
});

describe("attachReferences", () => {
  function mkIndex(symbols: SymbolEntry[]): SymbolIndex {
    return {
      appName: "x",
      refreshedAt: "now",
      scannedDirs: ["hooks", "components"],
      fileCount: symbols.length,
      symbols,
    };
  }

  it("returns [] when symbol index is null/empty", () => {
    expect(
      attachReferences({ appPath: "/x", taskBody: "form state", symbolIndex: null }),
    ).toEqual([]);
    expect(
      attachReferences({
        appPath: "/x", taskBody: "form state",
        symbolIndex: mkIndex([]),
      }),
    ).toEqual([]);
  });

  it("attaches the top-scoring file's content with score badge", () => {
    const root = mktmp("attach");
    try {
      writeFile(root, "hooks/useFormState.ts", "export function useFormState() {}");
      const out = attachReferences({
        appPath: root,
        taskBody: "Refactor the form state hook to use a reducer.",
        symbolIndex: mkIndex([
          { name: "useFormState", kind: "function", file: "hooks/useFormState.ts", signature: "" },
          { name: "validateForm", kind: "function", file: "hooks/useFormState.ts", signature: "" },
        ]),
      });
      expect(out).toHaveLength(1);
      expect(out[0].rel).toBe("hooks/useFormState.ts");
      expect(out[0].content).toContain("useFormState");
      expect(out[0].score).toBeGreaterThan(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("respects MAX_REFERENCES cap", () => {
    const root = mktmp("max");
    try {
      const symbols: SymbolEntry[] = [];
      for (let i = 0; i < 8; i++) {
        const file = `hooks/form${i}.ts`;
        writeFile(root, file, `export function form${i}() {}`);
        symbols.push({ name: `form${i}`, kind: "function", file, signature: "" });
        symbols.push({ name: `form${i}State`, kind: "const", file, signature: "" });
      }
      const out = attachReferences({
        appPath: root,
        taskBody: "form state",
        symbolIndex: mkIndex(symbols),
      });
      expect(out.length).toBeLessThanOrEqual(__test.MAX_REFERENCES);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("excludes files already in pinned list", () => {
    const root = mktmp("exclude");
    try {
      writeFile(root, "hooks/useFormState.ts", "X");
      const out = attachReferences({
        appPath: root,
        taskBody: "form state",
        symbolIndex: mkIndex([
          { name: "useFormState", kind: "function", file: "hooks/useFormState.ts", signature: "" },
          { name: "useForm", kind: "function", file: "hooks/useFormState.ts", signature: "" },
        ]),
        excludePaths: ["hooks/useFormState.ts"],
      });
      expect(out).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects symbol files that escape the app root", () => {
    const root = mktmp("escape");
    try {
      const out = attachReferences({
        appPath: root,
        taskBody: "form state",
        symbolIndex: mkIndex([
          { name: "x", kind: "function", file: "../../../etc/passwd", signature: "" },
        ]),
      });
      expect(out).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
