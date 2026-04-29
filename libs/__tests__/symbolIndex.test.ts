import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { __test, scanSymbols, type SymbolEntry } from "../symbolIndex";

function mktmp(label: string): string {
  return mkdtempSync(join(tmpdir(), `bridge-symbols-${label}-`));
}

function writeFiles(root: string, files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(root, rel);
    mkdirSync(abs.replace(/[\\/][^\\/]+$/, ""), { recursive: true });
    writeFileSync(abs, content, "utf8");
  }
}

describe("__test.extractExports", () => {
  it("captures function / const / class / interface / type at module scope", () => {
    const src = [
      "export function foo() { return 1 }",
      "export const bar = (x: number) => x * 2",
      "export class Baz { method() {} }",
      "export interface Qux { id: string }",
      "export type Alias = string | number",
    ].join("\n");
    const out = __test.extractExports(src, "lib/sample.ts");
    expect(out.map((s) => s.name)).toEqual(["foo", "bar", "Baz", "Qux", "Alias"]);
    expect(out.map((s) => s.kind)).toEqual([
      "function", "const", "class", "interface", "type",
    ]);
  });

  it("tags PascalCase exports in .tsx files as components", () => {
    const src = "export const Button = (props: Props) => <button {...props} />;";
    const out = __test.extractExports(src, "components/ui/Button.tsx");
    expect(out[0]?.kind).toBe("component");
  });

  it("tags PascalCase function exports in .tsx files as components", () => {
    const src = "export function Modal({ open }: { open: boolean }) { return open ? null : null }";
    const out = __test.extractExports(src, "components/Modal.tsx");
    expect(out[0]?.kind).toBe("component");
  });

  it("does NOT tag lowercase function exports in .tsx files as components", () => {
    const src = "export function helper(x: number) { return x }";
    const out = __test.extractExports(src, "components/util.tsx");
    expect(out[0]?.kind).toBe("function");
  });

  it("ignores `export default` (no useful name)", () => {
    const src = [
      "export default function pageComponent() { return null }",
      "export const Sidebar = () => null",
    ].join("\n");
    const out = __test.extractExports(src, "components/Sidebar.tsx");
    expect(out.map((s) => s.name)).toEqual(["Sidebar"]);
  });

  it("captures the rest of the line as signature, capped + collapsed", () => {
    const longSig = "x".repeat(200);
    const src = `export const huge = (${longSig}) => 1`;
    const out = __test.extractExports(src, "lib/x.ts");
    expect(out[0]?.signature.length).toBeLessThanOrEqual(120 + 1); // +1 for ellipsis
    expect(out[0]?.signature.endsWith("…")).toBe(true);
  });

  it("tolerates async function exports", () => {
    const src = "export async function fetchUsers() { return [] }";
    const out = __test.extractExports(src, "lib/api.ts");
    expect(out[0]?.name).toBe("fetchUsers");
    expect(out[0]?.kind).toBe("function");
  });
});

describe("scanSymbols", () => {
  it("returns empty index when no source files exist", () => {
    const root = mktmp("empty");
    try {
      const idx = scanSymbols(root);
      expect(idx.symbols).toEqual([]);
      expect(idx.scannedDirs).toEqual([]);
      expect(idx.fileCount).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("walks the default dirs (lib, utils, hooks, components/ui)", () => {
    const root = mktmp("default");
    try {
      writeFiles(root, {
        "lib/cn.ts": "export function cn(...args: string[]) { return args.join(' ') }",
        "utils/date.ts": "export const formatDate = (d: Date) => d.toISOString()",
        "hooks/useToast.ts": "export function useToast() { return { toast: () => {} } }",
        "components/ui/Button.tsx": "export const Button = () => null",
        // Should be ignored — outside default dirs
        "src/random.ts": "export const ignored = 1",
      });
      const idx = scanSymbols(root);
      const names = idx.symbols.map((s: SymbolEntry) => s.name);
      expect(names).toContain("cn");
      expect(names).toContain("formatDate");
      expect(names).toContain("useToast");
      expect(names).toContain("Button");
      expect(names).not.toContain("ignored");
      expect(idx.scannedDirs).toEqual(["lib", "utils", "hooks", "components/ui"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects symbolDirs that escape the app root (defense-in-depth)", () => {
    const root = mktmp("escape");
    try {
      writeFiles(root, {
        "lib/keep.ts": "export const Inside = 1",
      });
      // Pretend the operator wrote `bridge.json.symbolDirs: ["../../etc", "/abs", ""]`
      // — none of these should land outside the app, even though each
      // would otherwise be a valid path. The "lib" entry must still be
      // walked so the rejection is selective, not all-or-nothing.
      const idx = scanSymbols(root, ["../../etc", "/abs/somewhere", "", "lib"]);
      expect(idx.scannedDirs).toEqual(["lib"]);
      expect(idx.symbols.map((s) => s.name)).toEqual(["Inside"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("honors explicit symbolDirs override", () => {
    const root = mktmp("override");
    try {
      writeFiles(root, {
        "src/a.ts": "export const fromSrc = 1",
        "lib/b.ts": "export const fromLib = 2",
      });
      const idx = scanSymbols(root, ["src"]);
      const names = idx.symbols.map((s: SymbolEntry) => s.name);
      expect(names).toEqual(["fromSrc"]);
      expect(idx.scannedDirs).toEqual(["src"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("skips test/spec/.d.ts files", () => {
    const root = mktmp("skip");
    try {
      writeFiles(root, {
        "lib/foo.ts": "export const Foo = 1",
        "lib/foo.test.ts": "export const FooTest = 2",
        "lib/foo.spec.ts": "export const FooSpec = 3",
        "lib/foo.d.ts": "export const FooDts = 4",
      });
      const idx = scanSymbols(root);
      const names = idx.symbols.map((s) => s.name);
      expect(names).toContain("Foo");
      expect(names).not.toContain("FooTest");
      expect(names).not.toContain("FooSpec");
      expect(names).not.toContain("FooDts");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("skips node_modules / .next / dist / __tests__", () => {
    const root = mktmp("skipdirs");
    try {
      writeFiles(root, {
        "lib/keep.ts": "export const Keep = 1",
        "lib/node_modules/x.ts": "export const Skip1 = 2",
        "lib/__tests__/inner.ts": "export const Skip2 = 3",
        "lib/dist/output.ts": "export const Skip3 = 4",
      });
      const idx = scanSymbols(root);
      const names = idx.symbols.map((s) => s.name);
      expect(names).toContain("Keep");
      expect(names).not.toContain("Skip1");
      expect(names).not.toContain("Skip2");
      expect(names).not.toContain("Skip3");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("records file paths relative to the app root with posix separators", () => {
    const root = mktmp("paths");
    try {
      writeFiles(root, {
        "lib/sub/dir/x.ts": "export const Nested = 1",
      });
      const idx = scanSymbols(root);
      expect(idx.symbols[0]?.file).toBe("lib/sub/dir/x.ts");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
