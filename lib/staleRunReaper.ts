import { applyManyRuns, readMeta, type Meta, type Run } from "./meta";

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
 *
 * H6: previously this looped `updateRun` per stale run, doing N full
 * read-modify-write cycles. Now we do **one** read, build the patch
 * list in memory, and call `applyManyRuns` which performs a single
 * locked write while still emitting per-run lifecycle events for the
 * SSE stream (so the UI's transition animation still fires per row).
 */
export async function reapStaleRunsForDir(sessionsDir: string): Promise<Meta | null> {
  const meta = readMeta(sessionsDir);
  if (!meta) return null;
  const cutoff = Date.now() - staleThresholdMs();
  const now = new Date().toISOString();
  const patches: Array<{ sessionId: string; patch: Partial<Run> }> = [];
  for (const run of meta.runs) {
    if (run.status !== "running") continue;
    const started = run.startedAt ? Date.parse(run.startedAt) : NaN;
    // No parseable startedAt → can't tell when this run actually
    // started. Treat it as already-stale: better to flip a healthy run
    // to failed (recoverable: user clicks Continue) than to leave a
    // ghost in the meta forever.
    const isStale = !Number.isFinite(started) || started < cutoff;
    if (!isStale) continue;
    patches.push({
      sessionId: run.sessionId,
      patch: { status: "failed", endedAt: now },
    });
  }
  if (patches.length === 0) return meta;
  // applyManyRuns re-reads under the lock and returns the post-write
  // meta — that's the canonical state to hand back, not our pre-write
  // snapshot.
  return (await applyManyRuns(sessionsDir, patches)) ?? meta;
}
