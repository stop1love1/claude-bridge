import { readMeta, updateRun, type Meta } from "./meta";

/**
 * Lazy reaper for runs that crashed without an exit signal — e.g. the
 * dev server was killed mid-run, or hot-reload swapped out the child
 * process listener before it could fire. Each `meta.json` carries
 * `runs[].startedAt`; any run still flagged `running` past
 * `BRIDGE_STALE_RUN_MIN` minutes (default 30) gets flipped to `failed`
 * with a stale reason and a synthetic `endedAt`. Idempotent.
 *
 * Called from `GET /api/tasks` and friends — no background timer, no
 * cron, no extra process. The cost is one stat per running run per
 * read, which is negligible against the meta poll cadence.
 */

const DEFAULT_STALE_MIN = 30;

function staleThresholdMs(): number {
  const raw = process.env.BRIDGE_STALE_RUN_MIN;
  const n = raw ? Number(raw) : DEFAULT_STALE_MIN;
  return (Number.isFinite(n) && n > 0 ? n : DEFAULT_STALE_MIN) * 60_000;
}

/**
 * Reap one task's stale runs in place. Returns the meta with the
 * mutations already on disk — caller can hand it straight to the API
 * response. If the directory has no meta, returns null.
 */
export function reapStaleRunsForDir(sessionsDir: string): Meta | null {
  const meta = readMeta(sessionsDir);
  if (!meta) return null;
  const cutoff = Date.now() - staleThresholdMs();
  for (const run of meta.runs) {
    if (run.status !== "running") continue;
    const started = run.startedAt ? Date.parse(run.startedAt) : NaN;
    // No parseable startedAt → can't tell when this run actually
    // started. Treat it as already-stale: better to flip a healthy run
    // to failed (recoverable: user clicks Continue) than to leave a
    // ghost in the meta forever.
    const isStale = !Number.isFinite(started) || started < cutoff;
    if (!isStale) continue;
    const now = new Date().toISOString();
    updateRun(sessionsDir, run.sessionId, { status: "failed", endedAt: now });
    run.status = "failed";
    run.endedAt = now;
  }
  return meta;
}
