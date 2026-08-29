import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileUnderRoot } from "../readFileUnderRoot";

let root: string;
let outside: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "bridge-readfile-root-"));
  outside = mkdtempSync(join(tmpdir(), "bridge-readfile-outside-"));
  mkdirSync(join(root, "libs"), { recursive: true });
  writeFileSync(join(root, "libs", "a.ts"), "line1\nline2\nline3\n");
  writeFileSync(join(outside, "secret.txt"), "do not read me");
});

afterEach(() => {
  for (const d of [root, outside]) {
    try { rmSync(d, { recursive: true, force: true }); } catch { }
  }
});

describe("readFileUnderRoot", () => {
  it("reads a file below the root", () => {
    const r = readFileUnderRoot(root, "libs/a.ts");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.content).toBe("line1\nline2\nline3\n");
    expect(r.path).toBe("libs/a.ts");
    expect(r.truncated).toBe(false);
  });

  it("accepts backslashes, which Windows references carry", () => {
    const r = readFileUnderRoot(root, "libs\\a.ts");
    expect(r.ok).toBe(true);
  });

  it("refuses to climb out of the root", () => {
    for (const p of ["../secret.txt", "libs/../../secret.txt", "libs/./../../x"]) {
      const r = readFileUnderRoot(root, p);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toBe("invalid-path");
    }
  });

  it("refuses an absolute path pointing elsewhere", () => {
    const r = readFileUnderRoot(root, join(outside, "secret.txt"));
    expect(r.ok).toBe(false);
  });

  it("refuses an empty path and a NUL byte", () => {
    expect(readFileUnderRoot(root, null).ok).toBe(false);
    expect(readFileUnderRoot(root, "").ok).toBe(false);
    expect(readFileUnderRoot(root, "libs/a\0.ts").ok).toBe(false);
  });

  it("reports a missing file apart from a rejected one", () => {
    const r = readFileUnderRoot(root, "libs/nope.ts");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("not-found");
  });

  it("refuses a directory", () => {
    const r = readFileUnderRoot(root, "libs");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("not-a-file");
  });

  it("refuses a binary file rather than returning mojibake", () => {
    writeFileSync(join(root, "logo.bin"), Buffer.from([0x89, 0x50, 0x00, 0x01, 0x02]));
    const r = readFileUnderRoot(root, "logo.bin");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("binary");
  });

  it("truncates a large file and says so", () => {
    writeFileSync(join(root, "big.txt"), "x".repeat(2048));
    const r = readFileUnderRoot(root, "big.txt", { maxBytes: 100 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.content.length).toBe(100);
    expect(r.truncated).toBe(true);
  });
});
