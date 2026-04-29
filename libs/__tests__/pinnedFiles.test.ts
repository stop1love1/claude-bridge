import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, isAbsolute } from "node:path";
import { __test, loadPinnedFiles } from "../pinnedFiles";

function mktmp(label: string): string {
  return mkdtempSync(join(tmpdir(), `bridge-pinned-${label}-`));
}

function writeFile(root: string, rel: string, content: string | Buffer): void {
  const abs = join(root, rel);
  mkdirSync(abs.replace(/[\\/][^\\/]+$/, ""), { recursive: true });
  writeFileSync(abs, content);
}

describe("__test.resolveSafely", () => {
  const root = "/abs/app";

  it("rejects empty input", () => {
    expect(__test.resolveSafely(root, "")).toBeNull();
  });

  it("rejects absolute paths", () => {
    expect(__test.resolveSafely(root, "/etc/passwd")).toBeNull();
  });

  it("rejects path traversal that escapes the app root", () => {
    expect(__test.resolveSafely(root, "../../etc/passwd")).toBeNull();
    expect(__test.resolveSafely(root, "subdir/../../escape.ts")).toBeNull();
  });

  it("accepts paths that resolve inside the app", () => {
    const got = __test.resolveSafely(root, "src/foo.ts");
    expect(got).not.toBeNull();
    expect(isAbsolute(got!)).toBe(true);
  });
});

describe("loadPinnedFiles", () => {
  it("returns [] when no pinned paths are configured", () => {
    const root = mktmp("none");
    try {
      expect(loadPinnedFiles(root, [])).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("returns [] when appPath is empty", () => {
    expect(loadPinnedFiles("", ["foo.ts"])).toEqual([]);
  });

  it("loads listed files with content + posix path", () => {
    const root = mktmp("basic");
    try {
      writeFile(root, "src/api.ts", "export const apiUrl = '/api';");
      writeFile(root, "types/user.ts", "export interface User { id: string }");
      const out = loadPinnedFiles(root, ["src/api.ts", "types/user.ts"]);
      expect(out).toHaveLength(2);
      expect(out[0]).toMatchObject({
        rel: "src/api.ts",
        content: "export const apiUrl = '/api';",
        truncated: false,
      });
      expect(out[1].rel).toBe("types/user.ts");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("normalises Windows-style backslashes to forward slashes in `rel`", () => {
    const root = mktmp("backslash");
    try {
      writeFile(root, "src/foo.ts", "export const X = 1");
      const out = loadPinnedFiles(root, ["src\\foo.ts"]);
      expect(out[0]?.rel).toBe("src/foo.ts");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("silently skips missing / unsafe / non-string entries", () => {
    const root = mktmp("skip");
    try {
      writeFile(root, "src/exists.ts", "ok");
      const out = loadPinnedFiles(root, [
        "src/exists.ts",
        "src/missing.ts",
        "/etc/passwd",
        "../../escape.ts",
        "",
        // @ts-expect-error — intentionally pass a non-string to test runtime guard
        42,
      ]);
      expect(out.map((f) => f.rel)).toEqual(["src/exists.ts"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("caps each file at 4 KB and marks truncated", () => {
    const root = mktmp("trunc");
    try {
      writeFile(root, "big.ts", "x".repeat(8 * 1024));
      const out = loadPinnedFiles(root, ["big.ts"]);
      expect(out[0]?.truncated).toBe(true);
      expect(out[0]?.content.length).toBe(__test.PER_FILE_CAP_BYTES);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("caps the result list at MAX_FILES entries", () => {
    const root = mktmp("max");
    try {
      const total = __test.MAX_FILES + 4;
      const requests: string[] = [];
      for (let i = 0; i < total; i++) {
        const rel = `lib/file${i}.ts`;
        writeFile(root, rel, `export const v${i} = ${i}`);
        requests.push(rel);
      }
      const out = loadPinnedFiles(root, requests);
      expect(out).toHaveLength(__test.MAX_FILES);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
