/**
 * Read / write `DetectedScope` from `sessions/<task-id>/meta.json`.
 *
 * Detection runs once per task at create time (in `tasksStore.createTask`)
 * and the result is persisted alongside the task header. Subsequent
 * coordinator + child spawns read this cached value — no re-detection
 * per spawn — so coordinator and every child see the SAME scope.
 *
 * Refresh path: `POST /api/tasks/<id>/detect/refresh` clears the cache
 * and re-runs detection. Used when the user edits the task body.
 *
 * Stale-value gate: if the cached `taskBodyHash` doesn't match the
 * current `taskBody`, the cache is treated as miss. This guards against
 * older meta.json files written before detect was wired in, and against
 * task-body edits that bypassed the refresh route.
 */
import { createHash } from "node:crypto";
import { readMeta, withTaskLock, writeMeta, type Meta } from "../meta";
import type { DetectedScope, DetectedScopeCacheEntry } from "./types";

// Re-export so existing imports of `DetectedScopeCacheEntry` from this
// module keep working — the canonical type now lives in `./types` to
// break the import cycle with `lib/meta.ts`.
export type { DetectedScopeCacheEntry };

/**
 * Hash a task body so we can detect when it's changed without diffing
 * the whole text. SHA-1 is fine here — collision resistance isn't a
 * security property, just a "did the body change" signal.
 */
export function hashTaskBody(body: string): string {
  return createHash("sha1").update(body ?? "", "utf8").digest("hex").slice(0, 16);
}

/**
 * Read the cached scope for a task. Returns null when:
 *   - meta.json is missing
 *   - the cache field is absent (older meta written before detect existed)
 *   - the body hash doesn't match the current taskBody (stale)
 *
 * Always returns a fresh-seeming value to callers — they don't have to
 * branch on staleness, just on null vs scope.
 */
export function readScopeCache(
  sessionsDir: string,
): DetectedScope | null {
  const meta = readMeta(sessionsDir);
  if (!meta) return null;
  const entry = meta.detectedScope;
  if (!entry) return null;
  if (entry.taskBodyHash !== hashTaskBody(meta.taskBody)) return null;
  return entry.scope;
}

/**
 * Atomically write the scope cache into a task's meta.json under the
 * shared per-task lock. The caller doesn't need to worry about racing
 * other meta writers (run lifecycle, task header edit) — this helper
 * acquires the same `withTaskLock` mutex they use.
 */
export async function writeScopeCache(
  sessionsDir: string,
  scope: DetectedScope,
): Promise<void> {
  await withTaskLock(sessionsDir, () => {
    const meta = readMeta(sessionsDir);
    if (!meta) return;
    const next: Meta = {
      ...meta,
      detectedScope: {
        taskBodyHash: hashTaskBody(meta.taskBody),
        scope,
      },
    };
    writeMeta(sessionsDir, next);
  });
}

/**
 * Drop the cached scope for a task. Used by the explicit refresh route
 * before re-detection so a downstream read can't return the stale
 * value mid-flight.
 */
export async function clearScopeCache(sessionsDir: string): Promise<void> {
  await withTaskLock(sessionsDir, () => {
    const meta = readMeta(sessionsDir);
    if (!meta || !meta.detectedScope) return;
    const next: Meta = { ...meta };
    delete next.detectedScope;
    writeMeta(sessionsDir, next);
  });
}
