import { readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { applyManyRuns, readMeta, type Meta, type Run } from "./meta";
import { getChild } from "./spawnRegistry";
import { SESSIONS_DIR } from "./paths";

/**
 * Lazy reaper for runs whose `running` / `queued` state no longer
 * reflects reality. Two signals drive a flip to `stale`:
 *
 *   1. **Process gone (authoritative):** the run says `running` but
 *      `spawnRegistry` has no live `ChildProcess` for that session id.
 *      That means either (a) the bridge restarted (children died with
 *      it via tree-kill), (b) the child crashed and the lifecycle hook
 *      never got to flip the row, or (c) hot-reload dropped the
 *      listener. Either way the on-disk `running` is a lie — flip to
 *      `stale` immediately, no time grace, so the UI stops claiming
 *      work is in progress.
 *
 *   2. **Time-based fallback:** a row that survived the registry check
 *      (still `running` or `queued`) but has been in that state past
 *      `BRIDGE_STALE_RUN_MIN` (default 30 min) / `BRIDGE_QUEUED_STALE_MIN`
 *      (default 2 min) — covers cases where the registry entry exists
 *      but the wall-clock makes the run implausibly long.
 *
 * H4 introduced the `queued` intermediate state — a run is appended as
 * `queued` BEFORE the spawn, then promoted to `running` (or `failed`)
 * after the spawn returns. The queued cutoff is anchored to
 * `meta.createdAt`: if the meta was written more than 2 minutes ago and
 * we still see queued, the spawn definitely never promoted.
 *
 * On the very first call after bridge boot, `bootSweepIfNeeded` walks
 * every task's meta and flips zombie `running`/`queued` rows in bulk so
 * the UI shows truth from the first render, not after the user happens
 * to open each task. Idempotent; no background timer or cron.
 */

const DEFAULT_STALE_MIN = 30;
const DEFAULT_QUEUED_STALE_MIN = 2;

function staleThresholdMs(): number {
  const raw = process.env.BRIDGE_STALE_RUN_MIN;
  const n = raw ? Number(raw) : DEFAULT_STALE_MIN;
  return (Number.isFinite(n) && n > 0 ? n : DEFAULT_STALE_MIN) * 60_000;
}

function queuedStaleThresholdMs(): number {
  const raw = process.env.BRIDGE_QUEUED_STALE_MIN;
  const n = raw ? Number(raw) : DEFAULT_QUEUED_STALE_MIN;
  return (Number.isFinite(n) && n > 0 ? n : DEFAULT_QUEUED_STALE_MIN) * 60_000;
}

/**
 * Reap one task's stale runs in place. Returns the meta with the
 * mutations already on disk — caller can hand it straight to the API
 * response. If the directory has no meta, returns null.
 *
 * H6: previously this looped `updateRun` per stale run, doing N full
 * read-modify-write cycles. Now we do **one** read, build the patch
 * list in memory, and call `applyManyRuns` which performs a single
 * locked write while still emitting per-run lifecycle events for the
 * SSE stream (so the UI's transition animation still fires per row).
 */
export async function reapStaleRunsForDir(sessionsDir: string): Promise<Meta | null> {
  await bootSweepIfNeeded();
  const meta = readMeta(sessionsDir);
  if (!meta) return null;
  const patches = computeStalePatches(meta);
  if (patches.length === 0) return meta;
  return (await applyManyRuns(sessionsDir, patches)) ?? meta;
}

/**
 * Pure: given a meta snapshot, return the patch list for any rows that
 * should flip to `stale`. Two stale signals — registry-miss (process
 * gone) and time-cutoff (running/queued for too long). Exported only
 * for the boot-sweep helper below; outside callers should use
 * `reapStaleRunsForDir` so the writes go through the meta lock.
 */
function computeStalePatches(meta: Meta): Array<{ sessionId: string; patch: Partial<Run> }> {
  const nowMs = Date.now();
  const runningCutoff = nowMs - staleThresholdMs();
  const queuedCutoff = nowMs - queuedStaleThresholdMs();
  const metaCreated = Date.parse(meta.createdAt);
  const nowIso = new Date().toISOString();
  const patches: Array<{ sessionId: string; patch: Partial<Run> }> = [];
  for (const run of meta.runs) {
    let isStale = false;

    if (run.status === "running") {
      // Authoritative truth-check: if the bridge has no live child for
      // this session id, the run cannot still be running — bridge
      // restarted, child crashed, or hot-reload dropped the listener.
      // Bypass the time cutoff entirely so the UI stops lying within
      // the next polling tick instead of after 30 minutes.
      if (!getChild(run.sessionId)) {
        isStale = true;
      } else {
        const started = run.startedAt ? Date.parse(run.startedAt) : NaN;
        // No parseable startedAt → treat as already-stale: better to
        // flip a healthy run to stale (recoverable: Continue/Clear)
        // than to leave a ghost forever.
        isStale = !Number.isFinite(started) || started < runningCutoff;
      }
    } else if (run.status === "queued") {
      // H4-introduced state: appended before spawn, promoted after.
      // A queued row whose meta was written more than `queuedStale`
      // ago means the spawn definitely never promoted (queued is only
      // supposed to exist for milliseconds). The registry check is
      // skipped here on purpose — queued runs are pre-spawn so they
      // never had a registry entry to lose.
      isStale =
        !Number.isFinite(metaCreated) || metaCreated < queuedCutoff;
    } else {
      continue;
    }

    if (!isStale) continue;
    patches.push({
      sessionId: run.sessionId,
      patch: { status: "stale", endedAt: nowIso },
    });
  }
  return patches;
}

/**
 * One-shot sweep of every task's meta on first reaper call after bridge
 * boot. The previous bridge process (if any) tree-killed all spawned
 * children when it died, so any `running` row carried over in meta is
 * by definition a zombie. We flip them to `stale` in bulk so the UI
 * starts honest from the very first render — without this, each task's
 * status would only correct itself once the user happened to open it.
 *
 * Guarded by a module-level flag so concurrent first-callers cannot
 * trigger overlapping sweeps. Failures are swallowed: a bad meta file
 * mustn't block the rest of the sweep, and the per-task reaper will
 * retry the bad one on its next call anyway.
 */
let bootSweepDone = false;
let bootSweepInFlight: Promise<void> | null = null;
async function bootSweepIfNeeded(): Promise<void> {
  if (bootSweepDone) return;
  // Vitest runs against tmp dirs but `SESSIONS_DIR` resolves to the
  // bridge's real sessions/ — sweeping there during tests would mutate
  // the developer's actual meta files. The unit tests for this module
  // exercise reapStaleRunsForDir directly, so the boot path adds no
  // coverage anyway.
  if (process.env.VITEST) {
    bootSweepDone = true;
    return;
  }
  if (bootSweepInFlight) return bootSweepInFlight;
  bootSweepInFlight = (async () => {
    try {
      if (!existsSync(SESSIONS_DIR)) return;
      const ids = readdirSync(SESSIONS_DIR);
      for (const id of ids) {
        try {
          const dir = join(SESSIONS_DIR, id);
          const meta = readMeta(dir);
          if (!meta) continue;
          const patches = computeStalePatches(meta);
          if (patches.length > 0) {
            await applyManyRuns(dir, patches);
          }
        } catch (err) {
          console.warn(`boot-sweep: skipped ${id}`, err);
        }
      }
    } finally {
      bootSweepDone = true;
      bootSweepInFlight = null;
    }
  })();
  return bootSweepInFlight;
}
