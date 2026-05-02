import { NextResponse } from "next/server";
import { readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { SESSIONS_DIR } from "@/libs/paths";
import { reapStaleRunsForDir } from "@/libs/staleRunReaper";
import { withInFlight } from "@/libs/inFlight";
import { subscribeMetaAll } from "@/libs/meta";

export const dynamic = "force-dynamic";

// Whole-response cache. The board polls this endpoint every couple of
// seconds and dashboards with multiple tabs stack requests; without
// caching, each call reaps every task's stale runs (a write-amplifier
// against meta.json). 1.5 s is short enough that meta:changed events
// dominate freshness — see the subscribeMetaAll bust below — but long
// enough to absorb tab-storm bursts. Same pattern as the response cache
// in app/api/sessions/all/route.ts.
type MetaPayload = Record<string, unknown>;
const RESPONSE_TTL_MS = 1500;
let responseCache: { value: MetaPayload; expires: number } | null = null;

// Bust on any task lifecycle event. `subscribeMetaAll` returns an
// unsubscribe handle but we hold the listener for the process lifetime
// — same trick as app/api/sessions/all/route.ts. Pinned to globalThis
// so an HMR reload of the route module doesn't double-subscribe.
const G = globalThis as unknown as { __bridgeTasksMetaSub?: boolean };
if (!G.__bridgeTasksMetaSub) {
  G.__bridgeTasksMetaSub = true;
  subscribeMetaAll(() => { responseCache = null; });
}

/**
 * Compute the meta map fresh: walk every task dir and reap any stale
 * `running` rows whose process has long since died. Wrapped in
 * `withInFlight` at the caller so two concurrent dashboards racing
 * a poll don't both do the reap pass.
 */
async function computeMeta(): Promise<MetaPayload> {
  const out: MetaPayload = {};
  if (!existsSync(SESSIONS_DIR)) return out;
  for (const id of readdirSync(SESSIONS_DIR)) {
    const meta = await reapStaleRunsForDir(join(SESSIONS_DIR, id));
    if (meta) out[id] = meta;
  }
  return out;
}

/**
 * Batched: every task's meta.json in one round-trip. Avoids the N+1
 * pattern of the board polling /api/tasks/:id/meta per task every tick.
 * Returns { [taskId]: Meta } — tasks without metadata are simply absent.
 *
 * Reaps stale `running` runs lazily on each call so the UI never
 * shows a permanently-running task whose process has long since died.
 *
 * Two layers in front of the reap pass:
 *   1. `withInFlight("tasks-meta", "all", …)` so concurrent callers
 *      share a single in-flight computation rather than each spawning
 *      its own reap pass.
 *   2. A 1.5 s response cache busted by `subscribeMetaAll` events so
 *      steady-state polling doesn't churn the disk.
 */
export async function GET() {
  const now = Date.now();
  if (responseCache && responseCache.expires > now) {
    return NextResponse.json(responseCache.value);
  }
  const fresh = await withInFlight("tasks-meta", "all", computeMeta);
  if (fresh !== null) {
    responseCache = { value: fresh, expires: Date.now() + RESPONSE_TTL_MS };
    return NextResponse.json(fresh);
  }
  // Another caller was already computing the meta map. The cache may
  // have settled while we waited — re-check and serve that. If it's
  // still empty (rare race: in-flight finished but bust event arrived
  // mid-resolve), fall back to a direct compute. A second concurrent
  // call here is acceptable; this branch is the slow path.
  const after = Date.now();
  if (responseCache && responseCache.expires > after) {
    return NextResponse.json(responseCache.value);
  }
  const fallback = await computeMeta();
  responseCache = { value: fallback, expires: Date.now() + RESPONSE_TTL_MS };
  return NextResponse.json(fallback);
}
