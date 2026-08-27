import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import {
  acquireProcessLock,
  releaseProcessLock,
  _internal,
} from "../processLock";

const { LOCK_FILE, isPidAlive } = _internal;

let saved: string | null = null;

beforeEach(() => {
  saved = existsSync(LOCK_FILE) ? readFileSync(LOCK_FILE, "utf8") : null;
  rmSync(LOCK_FILE, { force: true });
});

afterEach(() => {
  if (saved !== null) writeFileSync(LOCK_FILE, saved, "utf8");
  else rmSync(LOCK_FILE, { force: true });
});

describe("isPidAlive", () => {
  it("reports the current process as alive", () => {
    expect(isPidAlive(process.pid)).toBe(true);
  });

  it("reports an almost-certainly-dead pid as not alive", () => {
    expect(isPidAlive(2_000_000_000)).toBe(false);
  });

  it("rejects non-positive / non-integer pids", () => {
    expect(isPidAlive(0)).toBe(false);
    expect(isPidAlive(-1)).toBe(false);
    expect(isPidAlive(1.5)).toBe(false);
  });
});

describe("acquireProcessLock", () => {
  it("acquires when no lock exists and writes our pid", () => {
    const r = acquireProcessLock({ port: 7777, url: "http://x" });
    expect(r.acquired).toBe(true);
    expect(r.tookOverStale).toBe(false);
    const rec = JSON.parse(readFileSync(LOCK_FILE, "utf8"));
    expect(rec.pid).toBe(process.pid);
    expect(rec.port).toBe(7777);
  });

  it("re-acquires its own lock without flagging a stale takeover", () => {
    acquireProcessLock();
    const r = acquireProcessLock();
    expect(r.acquired).toBe(true);
    expect(r.tookOverStale).toBe(false);
  });

  it("reclaims a stale lock from a dead holder", () => {
    writeFileSync(LOCK_FILE, JSON.stringify({ pid: 2_000_000_000, bootAt: 0 }), "utf8");
    const r = acquireProcessLock();
    expect(r.acquired).toBe(true);
    expect(r.tookOverStale).toBe(true);
    expect(JSON.parse(readFileSync(LOCK_FILE, "utf8")).pid).toBe(process.pid);
  });

  it("refuses to steal a lock held by a live foreign process", async () => {
    const child: ChildProcess = spawn(
      process.execPath,
      ["-e", "setInterval(() => {}, 1000)"],
      { stdio: "ignore" },
    );
    try {
      await new Promise<void>((res, rej) => {
        child.once("spawn", () => res());
        child.once("error", rej);
      });
      const foreignPid = child.pid!;
      expect(foreignPid).not.toBe(process.pid);
      writeFileSync(LOCK_FILE, JSON.stringify({ pid: foreignPid, url: "http://other", bootAt: 0 }), "utf8");

      const r = acquireProcessLock();
      expect(r.acquired).toBe(false);
      expect(r.heldBy?.pid).toBe(foreignPid);
      expect(r.heldBy?.url).toBe("http://other");
      expect(JSON.parse(readFileSync(LOCK_FILE, "utf8")).pid).toBe(foreignPid);
    } finally {
      child.kill("SIGKILL");
    }
  });
});

describe("releaseProcessLock", () => {
  it("removes the lock when we own it", () => {
    acquireProcessLock();
    expect(existsSync(LOCK_FILE)).toBe(true);
    releaseProcessLock();
    expect(existsSync(LOCK_FILE)).toBe(false);
  });

  it("leaves a foreign holder's lock in place", () => {
    writeFileSync(LOCK_FILE, JSON.stringify({ pid: 2_000_000_001, bootAt: 0 }), "utf8");
    releaseProcessLock();
    expect(existsSync(LOCK_FILE)).toBe(true);
  });
});
