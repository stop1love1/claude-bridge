import { existsSync, statSync, openSync, readSync, closeSync } from "node:fs";
import { StringDecoder } from "node:string_decoder";

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

const SUM_CHUNK_BYTES = 256 * 1024;

function sumUsageFromFile(filePath: string): SessionUsage {
  const out: SessionUsage = { ...ZERO };
  let fd: number;
  try { fd = openSync(filePath, "r"); }
  catch { return out; }

  const buf = Buffer.alloc(SUM_CHUNK_BYTES);
  const decoder = new StringDecoder("utf8");
  let leftover = "";

  const consume = (line: string) => {
    if (!line) return;
    let entry: JsonlEntry;
    try { entry = JSON.parse(line) as JsonlEntry; }
    catch { return; }
    if (entry.type !== "assistant") return;
    const u = entry.message?.usage;
    if (!u) return;
    out.inputTokens          += pickNumber(u.input_tokens);
    out.outputTokens         += pickNumber(u.output_tokens);
    out.cacheCreationTokens  += pickNumber(u.cache_creation_input_tokens);
    out.cacheReadTokens      += pickNumber(u.cache_read_input_tokens);
    out.turns                += 1;
  };

  try {
    let pos = 0;
    while (true) {
      let n: number;
      try { n = readSync(fd, buf, 0, SUM_CHUNK_BYTES, pos); }
      catch { break; }
      if (n === 0) break;
      pos += n;
      const text = leftover + decoder.write(buf.subarray(0, n));
      const lastNl = text.lastIndexOf("\n");
      if (lastNl < 0) { leftover = text; continue; }
      const ready = text.slice(0, lastNl);
      leftover = text.slice(lastNl + 1);
      for (const line of ready.split("\n")) consume(line);
    }
    consume(leftover + decoder.end());
  } finally {
    try { closeSync(fd); } catch { }
  }
  return out;
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

  const out = sumUsageFromFile(filePath);

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
