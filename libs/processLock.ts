/**
 * Advisory single-process lock for the bridge's shared on-disk state.
 *
 * Why this exists: every write to `sessions/<id>/meta.json` is guarded
 * by an *in-process* per-task mutex (`withTaskLock` in `libs/meta.ts`).
 * That mutex is a `Map` on `globalThis` — it only serializes writers
 * inside ONE Node process. If a second bridge boots against the same
 * `SESSIONS_DIR` (a stale `next start` that never died, a second `bun
 * dev`, a copy-paste deploy on the same disk), the two processes share
 * no mutex. Their read-modify-write cycles on the same meta.json then
 * race, and the loser's append (a freshly-spawned run) is silently
 * dropped — the atomic rename guarantees the file is never *corrupt*,
 * but it does not guarantee both writers' changes survive.
 *
 * This module makes that failure mode loud instead of silent. On boot
 * the bridge tries to claim a lock file. If a *live* foreign process
 * already holds it, we surface a warning in the startup banner so the
 * operator knows to kill the duplicate. The lock is advisory — it never
 * blocks boot (consistent with every other startup check), it just
 * tells the truth.
 *
 * Staleness: a lock whose recorded PID is no longer alive (previous
 * process crashed without releasing) is taken over silently — that's
 * the normal restart-after-crash path, not an error.
 */

import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BRIDGE_STATE_DIR } from "./paths";

const LOCK_FILE = join(BRIDGE_STATE_DIR, "bridge.lock");

interface LockRecord {
  pid: number;
  port?: number;
  url?: string;
  /** ms epoch when this holder booted. Informational only. */
  bootAt: number;
}

export interface LockResult {
  /** True when this process now owns the lock. */
  acquired: boolean;
  /** True when we reclaimed a stale lock (previous holder was dead). */
  tookOverStale: boolean;
  /** When `acquired` is false, the live foreign holder we lost to. */
  heldBy: LockRecord | null;
}

/**
 * Is `pid` a live process? Uses signal 0, which performs the kernel's
 * permission/existence check without delivering a signal — works on
 * Windows under Node too.
 *
 *   - throws ESRCH → no such process (dead) → false
 *   - throws EPERM → process exists but we can't signal it (alive) → true
 *   - no throw → alive → true
 */
function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  // A process can never be "the same as us but dead"; short-circuit so a
  // re-run within the same process (HMR) always reads as alive/ours.
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
    // Missing or corrupt → treat as no lock (safe to take over).
    return null;
  }
}

function writeLock(rec: LockRecord): void {
  mkdirSync(BRIDGE_STATE_DIR, { recursive: true });
  // 'wx' = create-exclusive: atomically fails with EEXIST if the file
  // already exists, which closes the read-then-write race between two
  // processes booting at the same instant. The caller only reaches here
  // after deciding any existing lock is stale/ours, so on EEXIST we
  // overwrite — the existing file is known-safe to replace.
  try {
    writeFileSync(LOCK_FILE, JSON.stringify(rec), { encoding: "utf8", flag: "wx" });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    writeFileSync(LOCK_FILE, JSON.stringify(rec), "utf8");
  }
}

/**
 * Attempt to claim the bridge's process lock for the current
 * `SESSIONS_DIR`. Never throws — disk errors degrade to
 * `{ acquired: true }` so a permissions glitch on the lock file can't
 * stop the bridge from booting (the lock is advisory, not load-bearing).
 *
 * @param info  Optional port/url stamped into the lock for the banner.
 */
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
      // A different, live process owns it — do NOT steal the lock.
      return { acquired: false, tookOverStale: false, heldBy: existing };
    }
    const tookOverStale = !!existing && existing.pid !== process.pid;
    writeLock(me);
    return { acquired: true, tookOverStale, heldBy: null };
  } catch {
    // Best-effort: never let a lock-file IO error block boot.
    return { acquired: true, tookOverStale: false, heldBy: null };
  }
}

/**
 * Release the lock if (and only if) we still own it. Safe to call on
 * shutdown even when we never acquired it — a foreign holder's record
 * is left untouched.
 */
export function releaseProcessLock(): void {
  try {
    const existing = readLock();
    if (existing && existing.pid === process.pid) {
      rmSync(LOCK_FILE, { force: true });
    }
  } catch {
    /* best-effort on shutdown */
  }
}

/** Exposed for tests. */
export const _internal = { LOCK_FILE, isPidAlive, readLock };
