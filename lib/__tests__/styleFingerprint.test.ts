import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { __test, scanStyle } from "../styleFingerprint";

function mktmp(label: string): string {
  return mkdtempSync(join(tmpdir(), `bridge-style-${label}-`));
}

function writeFiles(root: string, files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(root, rel);
    mkdirSync(abs.replace(/[\\/][^\\/]+$/, ""), { recursive: true });
    writeFileSync(abs, content, "utf8");
  }
}

describe("__test.classifyFileName", () => {
  it("recognises PascalCase", () => {
    expect(__test.classifyFileName("Button")).toBe("PascalCase");
    expect(__test.classifyFileName("MainNav")).toBe("PascalCase");
  });
  it("recognises kebab-case", () => {
    expect(__test.classifyFileName("date-picker")).toBe("kebab-case");
    expect(__test.classifyFileName("foo-bar-baz")).toBe("kebab-case");
  });
  it("recognises camelCase", () => {
    expect(__test.classifyFileName("useToast")).toBe("camelCase");
    expect(__test.classifyFileName("apiHelpers")).toBe("camelCase");
  });
  it("falls back to mixed for other shapes", () => {
    expect(__test.classifyFileName("snake_case")).toBe("mixed");
    expect(__test.classifyFileName("UPPER")).toBe("mixed");
  });
  it("strips trailing .test/.spec for cleaner classification", () => {
    expect(__test.classifyFileName("Button.test")).toBe("PascalCase");
    expect(__test.classifyFileName("date-picker.spec")).toBe("kebab-case");
  });
});

describe("__test.pickMajority", () => {
  it("returns unknown when every count is zero", () => {
    expect(
      __test.pickMajority(
        [{ label: "a", count: 0 }, { label: "b", count: 0 }],
        { threshold: 0.7 },
        "unknown",
        "mixed",
      ),
    ).toBe("unknown");
  });
  it("returns the top bucket when above threshold", () => {
    expect(
      __test.pickMajority(
        [{ label: "single", count: 80 }, { label: "double", count: 20 }],
        { threshold: 0.7 },
        "unknown",
        "mixed",
      ),
    ).toBe("single");
  });
  it("returns mixed when no bucket crosses threshold", () => {
    expect(
      __test.pickMajority(
        [{ label: "single", count: 50 }, { label: "double", count: 50 }],
        { threshold: 0.7 },
        "unknown",
        "mixed",
      ),
    ).toBe("mixed");
  });
});

describe("scanStyle", () => {
  it("returns an all-unknown fingerprint for an empty repo", () => {
    const root = mktmp("empty");
    try {
      const fp = scanStyle(root);
      expect(fp.indent.kind).toBe("unknown");
      expect(fp.quotes).toBe("unknown");
      expect(fp.semicolons).toBe("unknown");
      expect(fp.exports).toBe("unknown");
      expect(fp.sampledFiles).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("detects 2-space indent + named exports + semicolons + double quotes", () => {
    const root = mktmp("twospace");
    try {
      // 5 files all with the same micro-style — well past every
      // pickMajority threshold.
      const sample = [
        'import { foo } from "./foo";',
        "",
        "export function bar(x: number): number {",
        "  if (x > 0) {",
        "    return x;",
        "  }",
        "  return 0;",
        "}",
        "",
        'export const greet = "hello";',
      ].join("\n");
      writeFiles(root, {
        "lib/a.ts": sample,
        "lib/b.ts": sample,
        "lib/c.ts": sample,
        "src/d.ts": sample,
        "src/e.ts": sample,
      });
      const fp = scanStyle(root);
      expect(fp.indent.kind).toBe("spaces");
      expect(fp.indent.width).toBe(2);
      expect(fp.quotes).toBe("double");
      expect(fp.semicolons).toBe("always");
      expect(fp.exports).toBe("named");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("detects PascalCase tsx file naming", () => {
    const root = mktmp("tsxnaming");
    try {
      writeFiles(root, {
        "components/Button.tsx": "export const Button = () => null",
        "components/Sidebar.tsx": "export const Sidebar = () => null",
        "components/MainNav.tsx": "export const MainNav = () => null",
        "components/Toast.tsx": "export const Toast = () => null",
        "components/Avatar.tsx": "export const Avatar = () => null",
      });
      const fp = scanStyle(root);
      expect(fp.fileNaming.tsx).toBe("PascalCase");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("skips test files when sampling", () => {
    const root = mktmp("skiptest");
    try {
      writeFiles(root, {
        "lib/a.ts": "export const a = 1",
        "lib/a.test.ts": "describe('a', () => {})",
        "lib/a.spec.ts": "describe('a spec', () => {})",
      });
      const fp = scanStyle(root);
      expect(fp.sampledFiles).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("biases toward .ts/.tsx files; .js used only as fallback", () => {
    const root = mktmp("biasts");
    try {
      writeFiles(root, {
        "lib/a.ts": "export const a = 1",
        "lib/b.js": "module.exports = 2",
      });
      const files = __test.sampleFiles(root);
      // `.ts` always appears first when present.
      expect(files[0]?.endsWith("a.ts")).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
