import { existsSync, readFileSync, statSync } from "node:fs";

export interface SessionUsage {
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
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

const USAGE_CACHE_MAX = 256;
const usageCache = new Map<string, SessionUsage>();

function usageCacheKey(path: string, mtimeMs: number, size: number): string {
  return `${path}:${mtimeMs}:${size}`;
}

export function __resetUsageCacheForTests(): void {
  usageCache.clear();
}

export function sumUsageFromJsonl(filePath: string): SessionUsage {
  if (!existsSync(filePath)) return { ...ZERO };
  let mtimeMs = 0;
  let size = 0;
  let cacheable = false;
  try {
    const st = statSync(filePath);
    mtimeMs = st.mtime.getTime();
    size = st.size;
    cacheable = true;
  } catch { }

  if (cacheable) {
    const key = usageCacheKey(filePath, mtimeMs, size);
    const hit = usageCache.get(key);
    if (hit) {
      usageCache.delete(key);
      usageCache.set(key, hit);
      return { ...hit };
    }
  }

  let raw: string;
  try { raw = readFileSync(filePath, "utf8"); }
  catch { return { ...ZERO }; }
  const out: SessionUsage = { ...ZERO };
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
