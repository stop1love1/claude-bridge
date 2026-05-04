import { readdirSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { applyManyRuns, readMeta, type Meta, type Run } from "./meta";
import { getChild } from "./spawnRegistry";
import { BRIDGE_FOLDER, BRIDGE_ROOT, SESSIONS_DIR, readBridgeMd } from "./paths";
import { resolveRepoCwd } from "./repos";
import { projectDirFor } from "./sessions";

/**
 * Lazy reaper for runs whose `running` / `queued` state no longer
 * reflects reality. Liveness is decided in two stages so the reaper
 * stays honest for both bridge-spawned AND externally-spawned (e.g.
 * a coordinator launched manually from a Claude Code IDE session)
 * runs:
 *
 *   1. **`spawnRegistry` hit** — the OS process is alive and the
 *      bridge owns it. Trust it. No time cutoff. A coordinator
 *      orchestrating long retry chains can legitimately run for
 *      hours; flipping it on a wall-clock cutoff while the process
 *      is healthy lies to the UI.
 *
 *   2. **`spawnRegistry` miss + recent `.jsonl` mtime** — the bridge
 *      doesn't track this child, but its transcript file was written
 *      to within `BRIDGE_STALE_RUN_MIN` (default 30 min). Two real
 *      cases land here:
 *        a) An externally-spawned coordinator (user opened Claude
 *           Code in the bridge folder, that session POSTed `/link`
 *           to register itself). It is never in spawnRegistry, but
 *           its `.jsonl` keeps growing as it talks to its tools.
 *        b) Bridge-spawned child whose lifecycle hook didn't fire
 *           (hot-reload dropped the listener). The `.jsonl` is
 *           frozen at its last write — eventually stale, just not
 *           immediately.
 *      Trust the run while the file is fresh; flip stale when it
 *      hasn't changed in the cutoff window.
 *
 *   3. **Registry miss + stale `.jsonl`** (or unresolvable cwd, or
 *      missing `.jsonl`) — flip `stale` immediately. The lifecycle
 *      hook should have already settled the row to done/failed; a
 *      registry-miss `running` row whose transcript hasn't moved is
 *      a zombie.
 *
 *   4. **`queued` row past `BRIDGE_QUEUED_STALE_MIN`** — flip to
 *      `stale`. Queued is pre-spawn (promoted to `running` within
 *      milliseconds of the spawn returning). A queued row past the
 *      cutoff means the spawn definitely never promoted. Anchored
 *      to `meta.createdAt` (queued runs have no `startedAt` yet).
 *
 * On the very first call after bridge boot, `bootSweepIfNeeded` walks
 * every task's meta and flips zombie `running`/`queued` rows in bulk
 * so the UI shows truth from the first render. Idempotent; no
 * background timer or cron.
 */

const DEFAULT_QUEUED_STALE_MIN = 2;
const DEFAULT_STALE_RUN_MIN = 30;

function queuedStaleThresholdMs(): number {
  const raw = process.env.BRIDGE_QUEUED_STALE_MIN;
  const n = raw ? Number(raw) : DEFAULT_QUEUED_STALE_MIN;
  return (Number.isFinite(n) && n > 0 ? n : DEFAULT_QUEUED_STALE_MIN) * 60_000;
}

function jsonlStaleThresholdMs(): number {
  const raw = process.env.BRIDGE_STALE_RUN_MIN;
  const n = raw ? Number(raw) : DEFAULT_STALE_RUN_MIN;
  return (Number.isFinite(n) && n > 0 ? n : DEFAULT_STALE_RUN_MIN) * 60_000;
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
 * Resolve the repo cwd for a run so the reaper can locate its
 * `.jsonl`. Coordinator-style runs (those whose `repo` matches the
 * bridge folder) live in `BRIDGE_ROOT`; everything else goes through
 * the apps registry. Returns `null` when the repo is unknown
 * (renamed / deleted), which the caller treats as "can't verify
 * liveness — assume stale".
 *
 * `bridgeMdCache` lets one boot-sweep iteration reuse a single
 * `readBridgeMd` parse instead of re-reading per run. Cleared after
 * the sweep finishes; per-task callers pay one parse per request,
 * which is already in the noise.
 */
type BridgeMdCache = { md: ReturnType<typeof readBridgeMd> | null; loaded: boolean };

function resolveRunCwd(run: Run, cache: BridgeMdCache): string | null {
  // Bridge-relative runs live at BRIDGE_ROOT regardless of role —
  // the coordinator self-registers with `repo: BRIDGE_FOLDER`, and
  // any orchestration agent the bridge spawns inside its own tree
  // shares the cwd. Cheap fast path before we touch bridge.md.
  if (run.repo === BRIDGE_FOLDER) return BRIDGE_ROOT;
  if (!cache.loaded) {
    try {
      cache.md = readBridgeMd();
    } catch {
      cache.md = null;
    }
    cache.loaded = true;
  }
  if (!cache.md) return null;
  try {
    return resolveRepoCwd(cache.md, BRIDGE_ROOT, run.repo);
  } catch {
    return null;
  }
}

/**
 * True when the run's `.jsonl` was written to within the JSONL-stale
 * cutoff. Returns `false` when the file is missing or the cwd can't
 * be resolved — caller treats both as "can't prove liveness, mark
 * stale" so a renamed-repo or never-existed transcript doesn't
 * ghost forever.
 */
function isJsonlFresh(run: Run, cache: BridgeMdCache, freshUntil: number): boolean {
  const cwd = resolveRunCwd(run, cache);
  if (!cwd) return false;
  const projectDir = projectDirFor(cwd);
  const jsonl = join(projectDir, `${run.sessionId}.jsonl`);
  if (!existsSync(jsonl)) return false;
  try {
    const stat = statSync(jsonl);
    return stat.mtimeMs > freshUntil;
  } catch {
    return false;
  }
}

/**
 * Pure(ish): given a meta snapshot, return the patch list for any
 * rows that should flip to `stale`. Touches the filesystem only to
 * stat the per-run `.jsonl` (fallback liveness check); no writes
 * happen here. Exported only for the boot-sweep helper below;
 * outside callers should use `reapStaleRunsForDir` so the writes go
 * through the meta lock.
 */
function computeStalePatches(meta: Meta): Array<{ sessionId: string; patch: Partial<Run> }> {
  const nowMs = Date.now();
  const queuedCutoff = nowMs - queuedStaleThresholdMs();
  const jsonlFreshUntil = nowMs - jsonlStaleThresholdMs();
  const metaCreated = Date.parse(meta.createdAt);
  const nowIso = new Date().toISOString();
  const cache: BridgeMdCache = { md: null, loaded: false };
  const patches: Array<{ sessionId: string; patch: Partial<Run> }> = [];
  for (const run of meta.runs) {
    let isStale = false;

    if (run.status === "running") {
      if (getChild(run.sessionId)) {
        // Bridge owns the process — trust the row, no time cutoff.
        isStale = false;
      } else {
        // Registry miss: fall back to the transcript's mtime. This
        // is the only liveness signal the bridge has for runs it
        // didn't spawn (e.g. a Claude Code IDE session that
        // self-registered via `/link`).
        isStale = !isJsonlFresh(run, cache, jsonlFreshUntil);
      }
    } else if (run.status === "queued") {
      // Queued is pre-spawn — promoted to running within
      // milliseconds when the spawn returns. A queued row past the
      // cutoff means the spawn definitely never promoted. Registry
      // and JSONL checks are skipped on purpose: queued runs were
      // never registered and have no transcript yet.
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
