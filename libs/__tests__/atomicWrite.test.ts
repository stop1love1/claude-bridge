import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const injected = vi.hoisted(() => ({
  faults: [] as NodeJS.ErrnoException[],
  renameCalls: 0,
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    default: actual,
    renameSync: (from: string, to: string) => {
      injected.renameCalls += 1;
      const fault = injected.faults.shift();
      if (fault) throw fault;
      return actual.renameSync(from, to);
    },
  };
});

import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
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

function errnoError(code: string, message?: string): NodeJS.ErrnoException {
  const err = new Error(
    message ?? `${code}: injected rename failure`,
  ) as NodeJS.ErrnoException;
  err.code = code;
  err.syscall = "rename";
  return err;
}

function staleTmpFiles(dir: string): string[] {
  return readdirSync(dir).filter((n) => n.endsWith(".tmp"));
}

function sleepDurations(
  spy: { mock: { calls: unknown[][] } },
): unknown[] {
  return spy.mock.calls.map((call) => call[3]);
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "atomic-write-"));
  injected.faults = [];
  injected.renameCalls = 0;
});

afterEach(() => {
  vi.restoreAllMocks();
  injected.faults = [];
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

describe("writeStringAtomic rename retry", () => {
  it("succeeds on the first attempt without sleeping", () => {
    const sleepSpy = vi.spyOn(Atomics, "wait");
    const target = join(tmp, "out.txt");
    writeStringAtomic(target, "first-try");
    expect(readFileSync(target, "utf8")).toBe("first-try");
    expect(injected.renameCalls).toBe(1);
    expect(sleepSpy).not.toHaveBeenCalled();
  });

  it("retries after a transient EPERM and still lands the content", () => {
    const sleepSpy = vi.spyOn(Atomics, "wait");
    injected.faults = [errnoError("EPERM")];
    const target = join(tmp, "out.txt");
    writeStringAtomic(target, "second-try");
    expect(readFileSync(target, "utf8")).toBe("second-try");
    expect(injected.renameCalls).toBe(2);
    expect(sleepSpy).toHaveBeenCalledTimes(1);
    expect(staleTmpFiles(tmp)).toEqual([]);
  });

  it("treats EACCES and EBUSY as retryable too", () => {
    const sleepSpy = vi.spyOn(Atomics, "wait");
    injected.faults = [errnoError("EACCES"), errnoError("EBUSY")];
    const target = join(tmp, "out.txt");
    writeStringAtomic(target, "third-try");
    expect(readFileSync(target, "utf8")).toBe("third-try");
    expect(injected.renameCalls).toBe(3);
    expect(sleepSpy).toHaveBeenCalledTimes(2);
    expect(staleTmpFiles(tmp)).toEqual([]);
  });

  it("gives up after four attempts, rethrows the original error, and unlinks the temp file", () => {
    const sleepSpy = vi.spyOn(Atomics, "wait");
    const first = errnoError("EPERM", "EPERM: attempt 1");
    injected.faults = [
      first,
      errnoError("EPERM", "EPERM: attempt 2"),
      errnoError("EPERM", "EPERM: attempt 3"),
      errnoError("EPERM", "EPERM: attempt 4"),
      errnoError("EPERM", "EPERM: attempt 5"),
    ];
    const target = join(tmp, "out.txt");
    let thrown: unknown;
    try {
      writeStringAtomic(target, "never lands");
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBe(first);
    expect(injected.renameCalls).toBe(4);
    expect(sleepDurations(sleepSpy)).toEqual([5, 15, 30]);
    expect(staleTmpFiles(tmp)).toEqual([]);
    expect(existsSync(target)).toBe(false);
  });

  it("rethrows a non-retryable code immediately without sleeping", () => {
    const sleepSpy = vi.spyOn(Atomics, "wait");
    const xdev = errnoError("EXDEV");
    injected.faults = [xdev];
    const target = join(tmp, "out.txt");
    expect(() => writeStringAtomic(target, "never lands")).toThrow(xdev);
    expect(injected.renameCalls).toBe(1);
    expect(sleepSpy).not.toHaveBeenCalled();
    expect(staleTmpFiles(tmp)).toEqual([]);
  });

  it("does not retry ENOENT, because a missing temp file is a bug rather than a lock", () => {
    const sleepSpy = vi.spyOn(Atomics, "wait");
    const missing = errnoError("ENOENT");
    injected.faults = [missing];
    const target = join(tmp, "out.txt");
    expect(() => writeStringAtomic(target, "never lands")).toThrow(missing);
    expect(injected.renameCalls).toBe(1);
    expect(sleepSpy).not.toHaveBeenCalled();
    expect(staleTmpFiles(tmp)).toEqual([]);
  });

  it("unlinks the temp file when a retry attempt fails with a different code than the first", () => {
    const isdir = errnoError("EISDIR");
    injected.faults = [errnoError("EPERM"), isdir];
    const target = join(tmp, "out.txt");
    let thrown: unknown;
    try {
      writeStringAtomic(target, "never lands");
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBe(isdir);
    expect(injected.renameCalls).toBe(2);
    expect(staleTmpFiles(tmp)).toEqual([]);
  });

  it("retries a real Windows EPERM from a destination handle held open (win32 only)", () => {
    if (process.platform !== "win32") return;
    const sleepSpy = vi.spyOn(Atomics, "wait");
    const target = join(tmp, "meta.json");
    writeFileSync(target, "old");
    const fd = openSync(target, "r");
    let thrown: NodeJS.ErrnoException | undefined;
    try {
      writeStringAtomic(target, "new");
    } catch (err) {
      thrown = err as NodeJS.ErrnoException;
    } finally {
      closeSync(fd);
    }
    expect(injected.faults).toEqual([]);
    expect(thrown?.code).toBe("EPERM");
    expect(injected.renameCalls).toBe(4);
    expect(sleepDurations(sleepSpy)).toEqual([5, 15, 30]);
    expect(readFileSync(target, "utf8")).toBe("old");
    expect(staleTmpFiles(tmp)).toEqual([]);
  });
});

describe("writeJsonAtomic", () => {
  it("lands the new JSON over an existing destination after a first-rename EPERM", () => {
    const target = join(tmp, "meta.json");
    writeFileSync(target, JSON.stringify({ section: "DOING" }) + "\n");
    injected.faults = [errnoError("EPERM")];
    writeJsonAtomic(target, { section: "BLOCKED", runs: [1, 2] });
    expect(JSON.parse(readFileSync(target, "utf8"))).toEqual({
      section: "BLOCKED",
      runs: [1, 2],
    });
    expect(injected.renameCalls).toBe(2);
    expect(staleTmpFiles(tmp)).toEqual([]);
  });

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
