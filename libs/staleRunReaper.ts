import { readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { applyManyRuns, readMeta, type Meta, type Run } from "./meta";
import { getChild } from "./spawnRegistry";
import { SESSIONS_DIR } from "./paths";

/**
 * Lazy reaper for runs whose `running` / `queued` state no longer
 * reflects reality. The bridge trusts the OS process registry as the
 * single source of truth for "is this run actually alive":
 *
 *   - **`running` row + process alive in `spawnRegistry`** → trust it,
 *     never flip to stale. A coordinator coordinating multiple child
 *     retries can legitimately stay running for hours; flipping it on
 *     a wall-clock cutoff while the OS process is healthy lies to the
 *     UI and breaks workflows. The user has the Stop button if a run
 *     genuinely needs to be killed.
 *
 *   - **`running` row + process gone (registry-miss)** → flip to
 *     `stale` immediately, no time grace. The lifecycle hook should
 *     have already turned this into `done` / `failed` on clean exit;
 *     a registry-miss `running` row is by definition a zombie (bridge
 *     restart, crashed child, hot-reload dropped the listener).
 *
 *   - **`queued` row past `BRIDGE_QUEUED_STALE_MIN`** → flip to
 *     `stale`. A run is appended as `queued` BEFORE the spawn and
 *     promoted to `running` after the spawn returns; queued is only
 *     supposed to exist for milliseconds, so a row that survived
 *     past the cutoff means the spawn definitely never promoted. The
 *     cutoff is anchored to `meta.createdAt` (no `startedAt` exists
 *     yet on a queued row).
 *
 * On the very first call after bridge boot, `bootSweepIfNeeded` walks
 * every task's meta and flips zombie `running`/`queued` rows in bulk so
 * the UI shows truth from the first render, not after the user happens
 * to open each task. Idempotent; no background timer or cron.
 */

const DEFAULT_QUEUED_STALE_MIN = 2;

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
  const queuedCutoff = nowMs - queuedStaleThresholdMs();
  const metaCreated = Date.parse(meta.createdAt);
  const nowIso = new Date().toISOString();
  const patches: Array<{ sessionId: string; patch: Partial<Run> }> = [];
  for (const run of meta.runs) {
    let isStale = false;

    if (run.status === "running") {
      // Single authoritative signal: is the OS process still alive?
      // - alive  → trust the run, regardless of how long it's been
      //            going. A coordinator orchestrating many child
      //            retries can legitimately run for hours.
      // - gone   → flip to stale immediately. The lifecycle hook
      //            should have already settled the row to done/failed
      //            on clean exit; a registry-miss `running` row means
      //            the bridge restarted, the child crashed, or
      //            hot-reload dropped the listener.
      isStale = !getChild(run.sessionId);
    } else if (run.status === "queued") {
      // Queued is pre-spawn — promoted to running within milliseconds
      // when the spawn returns. A queued row past the cutoff means
      // the spawn definitely never promoted. Anchored to
      // `meta.createdAt` because queued runs have no `startedAt`.
      // Registry check is skipped on purpose: queued runs were never
      // registered.
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
