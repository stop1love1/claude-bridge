/**
 * Tiny in-memory rate limiter for auth endpoints.
 *
 * The bridge is single-process (Next dev / Next start, never clustered),
 * so a Map in module scope is sufficient — no Redis dependency, no
 * cross-instance coordination problem to solve. We stash the live Map
 * on `globalThis` so HMR in dev doesn't reset the bucket each time
 * `app/api/auth/login/route.ts` is re-evaluated.
 *
 * Algorithm: fixed-window by `(bucket, key)`. Each call either:
 *   - returns `{ ok: true }` and increments the counter, OR
 *   - returns `{ ok: false, retryAfterMs }` if the window's cap is hit.
 *
 * The `key` is whatever the caller wants to limit on — usually the
 * remote IP for spray-style brute force, plus a separate per-email
 * bucket so an attacker who rotates source IPs still gets stopped
 * once they've poked at the same account too many times.
 *
 * We deliberately do NOT block forever — every window-length the
 * counter resets, so a typo'd password from a legit user clears
 * itself in ~10 minutes. The caller is responsible for picking a
 * window/cap balanced for their endpoint.
 */

interface Bucket {
  /** Wall-clock ms when the current window started. */
  windowStartMs: number;
  /** Hits in the current window. */
  hits: number;
}

interface Store {
  /** `${bucket}|${key}` → counters. */
  buckets: Map<string, Bucket>;
  /** Last gc timestamp; we sweep stale entries lazily. */
  lastGcMs: number;
}

const G = globalThis as unknown as { __bridgeRateLimit?: Store };
const store: Store =
  G.__bridgeRateLimit ??
  (G.__bridgeRateLimit = { buckets: new Map(), lastGcMs: Date.now() });

const GC_INTERVAL_MS = 5 * 60 * 1000;

function maybeGc(now: number, windowMs: number): void {
  if (now - store.lastGcMs < GC_INTERVAL_MS) return;
  for (const [k, b] of store.buckets) {
    if (now - b.windowStartMs > windowMs * 4) store.buckets.delete(k);
  }
  store.lastGcMs = now;
}

export interface RateLimitResult {
  ok: boolean;
  /** ms remaining in the current window (only meaningful when `ok=false`). */
  retryAfterMs: number;
  /** Hits inside the current window after this call. */
  hits: number;
  /** Configured cap for the bucket. */
  limit: number;
}

/**
 * Increment + check a fixed-window counter. Returns `ok: true` until
 * `limit` is reached within `windowMs`, then `ok: false` with the
 * time remaining in the window.
 *
 * Buckets with the same `key` but different `bucket` strings are
 * tracked separately, so callers can use one limiter for "per IP"
 * and another for "per email" without collisions.
 */
export function rateLimit(
  bucket: string,
  key: string,
  limit: number,
  windowMs: number,
): RateLimitResult {
  const now = Date.now();
  maybeGc(now, windowMs);
  const id = `${bucket}|${key}`;
  let b = store.buckets.get(id);
  if (!b || now - b.windowStartMs >= windowMs) {
    b = { windowStartMs: now, hits: 0 };
    store.buckets.set(id, b);
  }
  b.hits += 1;
  if (b.hits > limit) {
    return {
      ok: false,
      retryAfterMs: windowMs - (now - b.windowStartMs),
      hits: b.hits,
      limit,
    };
  }
  return { ok: true, retryAfterMs: 0, hits: b.hits, limit };
}

/**
 * Reset a `(bucket, key)` counter. Useful after a successful login —
 * the operator's correct-password attempt shouldn't keep them locked
 * out if they happened to typo a few times first.
 */
export function rateLimitClear(bucket: string, key: string): void {
  store.buckets.delete(`${bucket}|${key}`);
}
