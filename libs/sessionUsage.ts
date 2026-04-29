import { existsSync, readFileSync } from "node:fs";

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

export function sumUsageFromJsonl(filePath: string): SessionUsage {
  if (!existsSync(filePath)) return { ...ZERO };
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
