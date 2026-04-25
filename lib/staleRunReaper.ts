import { readMeta, updateRun, type Meta } from "./meta";

/**
 * Lazy reaper for runs that crashed without an exit signal — e.g. the
 * dev server was killed mid-run, or hot-reload swapped out the child
 * process listener before it could fire. Each `meta.json` carries
 * `runs[].startedAt`; any run still flagged `running` past
 * `BRIDGE_STALE_RUN_MIN` minutes (default 30) gets flipped to `failed`
 * with a stale reason and a synthetic `endedAt`.
 *
 * H4 introduced a `queued` intermediate state — a run is appended as
 * `queued` BEFORE the spawn, then promoted to `running` (or `failed`)
 * after the spawn returns. If the bridge dies in that narrow window,
 * the row is permanent garbage unless the reaper picks it up. We use a
 * much shorter timeout for queued rows (default 2 minutes) anchored to
 * `meta.createdAt` because:
 *   - the queued state is only supposed to exist for milliseconds in a
 *     healthy spawn;
 *   - the run row itself doesn't carry a `createdAt`, but `meta.createdAt`
 *     is a safe lower bound — if the meta was written more than 2
 *     minutes ago and we still see queued, the spawn definitely never
 *     promoted.
 *
 * Idempotent. Called from `GET /api/tasks/<id>/meta` — no background
 * timer, no cron, no extra process.
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
 */
export function reapStaleRunsForDir(sessionsDir: string): Meta | null {
  const meta = readMeta(sessionsDir);
  if (!meta) return null;
  const now = Date.now();
  const runningCutoff = now - staleThresholdMs();
  const queuedCutoff = now - queuedStaleThresholdMs();
  const metaCreated = Date.parse(meta.createdAt);
  for (const run of meta.runs) {
    let isStale = false;

    if (run.status === "running") {
      const started = run.startedAt ? Date.parse(run.startedAt) : NaN;
      // No parseable startedAt → can't tell when this run actually
      // started. Treat it as already-stale: better to flip a healthy
      // run to failed (recoverable: user clicks Continue) than to
      // leave a ghost in the meta forever.
      isStale = !Number.isFinite(started) || started < runningCutoff;
    } else if (run.status === "queued") {
      // H4-introduced state: appended before spawn, promoted after.
      // A queued row with startedAt:null that's older than the
      // queued cutoff (anchored on meta.createdAt as a safe lower
      // bound) means the spawn never completed — bridge crashed
      // between appendRun and updateRun. Flip to failed.
      isStale =
        !Number.isFinite(metaCreated) || metaCreated < queuedCutoff;
    } else {
      continue;
    }

    if (!isStale) continue;
    const stamp = new Date().toISOString();
    updateRun(sessionsDir, run.sessionId, { status: "failed", endedAt: stamp });
    run.status = "failed";
    run.endedAt = stamp;
  }
  return meta;
}
