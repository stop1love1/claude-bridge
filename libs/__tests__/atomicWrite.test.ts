import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { writeJsonAtomic, writeStringAtomic } from "../atomicWrite";

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "atomic-write-"));
});

afterEach(() => {
  try { rmSync(tmp, { recursive: true, force: true }); } catch { }
});

describe("writeStringAtomic", () => {
  it("writes the file and persists the exact contents", () => {
    const target = join(tmp, "out.txt");
    writeStringAtomic(target, "hello world");
    expect(readFileSync(target, "utf8")).toBe("hello world");
  });

  it("creates missing parent directories", () => {
    const target = join(tmp, "nested", "deep", "out.txt");
    writeStringAtomic(target, "ok");
    expect(readFileSync(target, "utf8")).toBe("ok");
  });

  it("overwrites an existing destination atomically", () => {
    const target = join(tmp, "out.txt");
    writeFileSync(target, "old");
    writeStringAtomic(target, "new");
    expect(readFileSync(target, "utf8")).toBe("new");
  });

  it("does not leave any *.tmp file in the directory after a successful write", () => {
    const target = join(tmp, "out.txt");
    writeStringAtomic(target, "x");
    const stale = readdirSync(tmp).filter((n) => n.endsWith(".tmp"));
    expect(stale).toEqual([]);
  });

  it("applies the requested mode on POSIX (skipped on Windows)", () => {
    if (process.platform === "win32") return;
    const target = join(tmp, "secret.txt");
    writeStringAtomic(target, "shh", { mode: 0o600 });
    const m = statSync(target).mode & 0o777;
    expect(m).toBe(0o600);
  });

  it("cleans up the tmp file when rename fails and re-throws", () => {
    const target = join(tmp, "occupied");
    mkdirSync(target);
    writeFileSync(join(target, "child.txt"), "blocker");

    expect(() => writeStringAtomic(target, "x")).toThrowError();
    const stale = readdirSync(tmp).filter((n) => n.endsWith(".tmp"));
    expect(stale).toEqual([]);
    expect(existsSync(join(target, "child.txt"))).toBe(true);
  });

  it("parallel writers all succeed without losing data (no shared tmp suffix race)", async () => {
    const target = join(tmp, "out.txt");
    const writers = Array.from({ length: 8 }, (_, i) =>
      Promise.resolve().then(() => writeStringAtomic(target, `payload-${i}`)),
    );
    await Promise.all(writers);
    const final = readFileSync(target, "utf8");
    expect(final).toMatch(/^payload-\d+$/);
    const stale = readdirSync(tmp).filter((n) => n.endsWith(".tmp"));
    expect(stale).toEqual([]);
  });
});

describe("writeJsonAtomic", () => {
  it("serializes value as JSON with trailing newline", () => {
    const target = join(tmp, "out.json");
    writeJsonAtomic(target, { a: 1, b: [2, 3] });
    const text = readFileSync(target, "utf8");
    expect(text.endsWith("\n")).toBe(true);
    expect(JSON.parse(text)).toEqual({ a: 1, b: [2, 3] });
  });

  it("formats with 2-space indent (matches the legacy ad-hoc helpers)", () => {
    const target = join(tmp, "out.json");
    writeJsonAtomic(target, { a: 1 });
    expect(readFileSync(target, "utf8")).toBe("{\n  \"a\": 1\n}\n");
  });

  it("forwards mode option to writeStringAtomic", () => {
    if (process.platform === "win32") return;
    const target = join(tmp, "out.json");
    writeJsonAtomic(target, { a: 1 }, { mode: 0o600 });
    const m = statSync(target).mode & 0o777;
    expect(m).toBe(0o600);
  });
});
