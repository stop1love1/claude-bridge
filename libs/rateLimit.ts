
interface Bucket {
  windowStartMs: number;
  hits: number;
}

interface Store {
  buckets: Map<string, Bucket>;
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
  retryAfterMs: number;
  hits: number;
  limit: number;
}

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

export function rateLimitClear(bucket: string, key: string): void {
  store.buckets.delete(`${bucket}|${key}`);
}

export interface RateLimitDenial {
  body: { error: string; hint: string };
  status: 429;
  headers: Record<string, string>;
}

export function checkRateLimit(
  bucket: string,
  key: string,
  limit: number,
  windowMs: number,
): RateLimitDenial | null {
  const r = rateLimit(bucket, key, limit, windowMs);
  if (r.ok) return null;
  return {
    body: { error: "too many requests", hint: "wait a few minutes before retrying" },
    status: 429,
    headers: { "Retry-After": String(Math.max(1, Math.ceil(r.retryAfterMs / 1000))) },
  };
}
