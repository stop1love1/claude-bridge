
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BRIDGE_STATE_DIR } from "./paths";

const LOCK_FILE = join(BRIDGE_STATE_DIR, "bridge.lock");

export interface LockRecord {
  pid: number;
  port?: number;
  url?: string;
  bootAt: number;
}

export interface LockResult {
  acquired: boolean;
  tookOverStale: boolean;
  heldBy: LockRecord | null;
}

function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

function readLock(): LockRecord | null {
  try {
    const raw = readFileSync(LOCK_FILE, "utf8");
    const parsed = JSON.parse(raw) as Partial<LockRecord>;
    if (typeof parsed?.pid !== "number") return null;
    return {
      pid: parsed.pid,
      port: typeof parsed.port === "number" ? parsed.port : undefined,
      url: typeof parsed.url === "string" ? parsed.url : undefined,
      bootAt: typeof parsed.bootAt === "number" ? parsed.bootAt : 0,
    };
  } catch {
    return null;
  }
}

class LockRaceLost extends Error {
  constructor(public readonly heldBy: LockRecord) {
    super("process lock race lost");
    this.name = "LockRaceLost";
  }
}

function writeLock(rec: LockRecord): void {
  mkdirSync(BRIDGE_STATE_DIR, { recursive: true });
  try {
    writeFileSync(LOCK_FILE, JSON.stringify(rec), { encoding: "utf8", flag: "wx" });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    const winner = readLock();
    if (winner && winner.pid !== process.pid && isPidAlive(winner.pid)) {
      throw new LockRaceLost(winner);
    }
    writeFileSync(LOCK_FILE, JSON.stringify(rec), "utf8");
  }
}

export function acquireProcessLock(info?: { port?: number; url?: string }): LockResult {
  const me: LockRecord = {
    pid: process.pid,
    port: info?.port,
    url: info?.url,
    bootAt: Date.now(),
  };
  try {
    const existing = readLock();
    if (existing && existing.pid !== process.pid && isPidAlive(existing.pid)) {
      return { acquired: false, tookOverStale: false, heldBy: existing };
    }
    const tookOverStale = !!existing && existing.pid !== process.pid;
    writeLock(me);
    return { acquired: true, tookOverStale, heldBy: null };
  } catch (err) {
    if (err instanceof LockRaceLost) {
      return { acquired: false, tookOverStale: false, heldBy: err.heldBy };
    }
    return { acquired: true, tookOverStale: false, heldBy: null };
  }
}

export function releaseProcessLock(): void {
  try {
    const existing = readLock();
    if (existing && existing.pid === process.pid) {
      rmSync(LOCK_FILE, { force: true });
    }
  } catch {
  }
}

export function isLockHolder(): boolean {
  try {
    const rec = readLock();
    return !!rec && rec.pid === process.pid;
  } catch {
    return false;
  }
}

export function readLockHolder(): LockRecord | null {
  return readLock();
}

export const _internal = { LOCK_FILE, isPidAlive, readLock };
