import { existsSync, readFileSync, statSync } from "node:fs";

/**
 * Aggregate token usage for a Claude Code session by walking its
 * `.jsonl` and summing the per-turn `message.usage` block. Cache reads
 * are tracked separately so the UI can show how much context was
 * served from cache vs. fresh.
 *
 * Returns zeros for missing / unreadable files so callers can sum
 * across an array of session paths without dealing with sparse data.
 */
export interface SessionUsage {
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  /** Number of assistant turns that contributed a usage block. */
  turns: number;
}

const ZERO: SessionUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheCreationTokens: 0,
  cacheReadTokens: 0,
  turns: 0,
};

interface JsonlEntry {
  type?: string;
  message?: {
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_creation_input_tokens?: number;
      cache_read_input_tokens?: number;
    };
  };
}

function pickNumber(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/**
 * Cache for `sumUsageFromJsonl`: keyed by `${path}:${mtimeMs}:${size}`
 * so a file rewrite (which always changes either mtime or size) misses
 * the cache. Most sessions stop changing the moment the run ends, so a
 * second / third / Nth `/api/sessions/all` poll hits this cache for
 * every steady-state file. Capped at 256 entries with insertion-order
 * eviction (Map preserves insertion order) — plenty for a long-running
 * dashboard with hundreds of sessions and bounded RAM (~tens of KB).
 *
 * Cache only successful parses. Stat / read failures fall through to a
 * zero result that is NOT cached — a transient ENOENT / EMFILE must
 * not poison the entry until the next file mutation.
 *
 * Mtime is taken from `st.mtime.getTime()` (integer ms) rather than
 * `st.mtimeMs` (which carries sub-ms precision on POSIX): integer ms
 * survives a `utimesSync` round-trip without hash drift, matches the
 * granularity Windows reports natively, and is plenty fine-grained for
 * detecting file mutations.
 */
const USAGE_CACHE_MAX = 256;
const usageCache = new Map<string, SessionUsage>();

function usageCacheKey(path: string, mtimeMs: number, size: number): string {
  return `${path}:${mtimeMs}:${size}`;
}

/**
 * Test helper: drop everything in the usage cache. Exported so unit
 * tests can verify miss-on-mtime-change without colliding with other
 * tests' cached entries.
 */
export function __resetUsageCacheForTests(): void {
  usageCache.clear();
}

export function sumUsageFromJsonl(filePath: string): SessionUsage {
  if (!existsSync(filePath)) return { ...ZERO };
  // Stat upfront so the cache key reflects the exact bytes we're about
  // to parse. statSync failure is non-cacheable; fall through to the
  // raw read which short-circuits via its own try/catch.
  let mtimeMs = 0;
  let size = 0;
  let cacheable = false;
  try {
    const st = statSync(filePath);
    mtimeMs = st.mtime.getTime();
    size = st.size;
    cacheable = true;
  } catch { /* fall through to uncached read */ }

  if (cacheable) {
    const key = usageCacheKey(filePath, mtimeMs, size);
    const hit = usageCache.get(key);
    if (hit) {
      // Insertion-order LRU bump so a hot key isn't evicted next.
      usageCache.delete(key);
      usageCache.set(key, hit);
      return { ...hit };
    }
  }

  let raw: string;
  try { raw = readFileSync(filePath, "utf8"); }
  catch { return { ...ZERO }; }
  const out: SessionUsage = { ...ZERO };
  // Stream-parse line-by-line so a malformed line in the middle of a
  // long log doesn't void the whole file.
  for (const line of raw.split("\n")) {
    if (!line) continue;
    let entry: JsonlEntry;
    try { entry = JSON.parse(line) as JsonlEntry; }
    catch { continue; }
    if (entry.type !== "assistant") continue;
    const u = entry.message?.usage;
    if (!u) continue;
    out.inputTokens          += pickNumber(u.input_tokens);
    out.outputTokens         += pickNumber(u.output_tokens);
    out.cacheCreationTokens  += pickNumber(u.cache_creation_input_tokens);
    out.cacheReadTokens      += pickNumber(u.cache_read_input_tokens);
    out.turns                += 1;
  }

  if (cacheable) {
    const key = usageCacheKey(filePath, mtimeMs, size);
    usageCache.set(key, { ...out });
    if (usageCache.size > USAGE_CACHE_MAX) {
      const oldest = usageCache.keys().next().value;
      if (oldest !== undefined) usageCache.delete(oldest);
    }
  }
  return out;
}

export function addUsage(a: SessionUsage, b: SessionUsage): SessionUsage {
  return {
    inputTokens:         a.inputTokens         + b.inputTokens,
    outputTokens:        a.outputTokens        + b.outputTokens,
    cacheCreationTokens: a.cacheCreationTokens + b.cacheCreationTokens,
    cacheReadTokens:     a.cacheReadTokens     + b.cacheReadTokens,
    turns:               a.turns               + b.turns,
  };
}
