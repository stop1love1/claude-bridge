import { describe, it, expect } from "vitest";
import { __test } from "../recentDirection";
import type { SymbolIndex } from "../symbolIndex";

const mkIndex = (files: string[]): SymbolIndex => ({
  appName: "x",
  refreshedAt: "now",
  scannedDirs: [],
  fileCount: files.length,
  symbols: files.map((file, i) => ({
    name: `helper${i}`,
    kind: "function" as const,
    file,
    signature: "",
  })),
});

describe("__test.pickTouchedDir", () => {
  it("returns null when symbol index is null/empty", () => {
    expect(__test.pickTouchedDir("anything", null)).toBeNull();
    expect(__test.pickTouchedDir("anything", mkIndex([]))).toBeNull();
  });

  it("returns null when task body has no useful tokens", () => {
    expect(__test.pickTouchedDir("the and of", mkIndex(["lib/x.ts"]))).toBeNull();
  });

  it("returns the parent dir of the top-scoring file", () => {
    const idx = mkIndex(["hooks/forms/useFormState.ts", "lib/util.ts"]);
    // Override symbol names to drive the score where we want
    idx.symbols = [
      { name: "useFormState", kind: "function", file: "hooks/forms/useFormState.ts", signature: "" },
      { name: "validateForm", kind: "function", file: "hooks/forms/useFormState.ts", signature: "" },
      { name: "cn", kind: "function", file: "lib/util.ts", signature: "" },
    ];
    const dir = __test.pickTouchedDir("Refactor the form state hook", idx);
    expect(dir).toBe("hooks/forms");
  });

  it("normalizes Windows-style backslashes in the returned dir", () => {
    const idx = mkIndex([]);
    idx.symbols = [
      // synthesized backslash path
      { name: "Form", kind: "component", file: "components\\forms\\Login.tsx", signature: "" },
      { name: "FormField", kind: "component", file: "components\\forms\\Field.tsx", signature: "" },
    ];
    const dir = __test.pickTouchedDir("login form field", idx);
    expect(dir).toBe("components/forms");
  });

  it("returns null when the top file is at the repo root (dirname = '.')", () => {
    const idx = mkIndex([]);
    idx.symbols = [
      { name: "main", kind: "function", file: "main.ts", signature: "" },
      { name: "mainHelper", kind: "function", file: "main.ts", signature: "" },
    ];
    const dir = __test.pickTouchedDir("main helper logic", idx);
    expect(dir).toBeNull();
  });
});
