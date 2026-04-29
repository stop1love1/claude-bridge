/**
 * P3b / B2 — auto-attach reference files.
 *
 * Heuristic: tokenize the task body, score each indexed symbol by
 * keyword overlap (file path + symbol name), pick the top N files,
 * and inject them into the child prompt as `## Reference files`.
 * The agent imitates real code in the repo instead of writing
 * generic boilerplate from training data.
 *
 * Operates entirely on the P3a symbol index — no extra disk scan,
 * no LLM call. Runs in milliseconds.
 *
 * Distinct from `pinnedFiles` (B3, P3a):
 *   - Pinned = operator-curated, ALWAYS injected
 *   - Reference = heuristic-picked from task body, varies per task
 */
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import type { SymbolIndex, SymbolEntry } from "./symbolIndex";

/** Per-file size cap mirrors `pinnedFiles` (4 KB). */
const PER_FILE_CAP_BYTES = 4 * 1024;
/** Total reference files attached per spawn. Smaller than pinned
 *  cap (8) because these are speculative — quality > quantity. */
const MAX_REFERENCES = 3;
/** Minimum keyword overlap score to consider attaching a file. Below
 *  this we'd be attaching noise. */
const MIN_SCORE = 2;
/** Stopwords skipped during task-body tokenization — avoid matching
 *  on filler words. Mirrors `repoProfile.STOPWORDS` shape but trimmed
 *  to the most common spawn-prompt offenders. */
const STOPWORDS = new Set([
  "the", "and", "a", "an", "of", "to", "for", "in", "on", "at",
  "is", "are", "be", "by", "as", "or", "with", "this", "that",
  "add", "fix", "update", "create", "make", "build", "use",
  "new", "old", "from", "into", "out", "do", "did", "done",
  "task", "todo", "should", "would", "need", "needs", "want",
  "wants", "please", "review", "implement", "function", "feature",
]);

export interface ReferenceFile {
  rel: string;
  content: string;
  truncated: boolean;
  /** Keyword overlap score that earned this file its slot. Surfaced
   *  in the prompt's `## Reference files` intro so the agent
   *  understands why a file was attached. */
  score: number;
}

/**
 * Tokenize a free-form text blob into lowercase keyword candidates.
 * Drops short tokens (<3 chars), stopwords, and pure-numeric tokens.
 */
export function tokenize(text: string): string[] {
  const out = new Set<string>();
  for (const raw of text.toLowerCase().split(/[^a-z0-9]+/g)) {
    const t = raw.trim();
    if (!t || t.length < 3) continue;
    if (STOPWORDS.has(t)) continue;
    if (/^\d+$/.test(t)) continue;
    out.add(t);
  }
  return [...out];
}

/**
 * Resolve a symbol's relative path safely against the app root.
 * Mirrors `pinnedFiles.resolveSafely`: rejects absolute and `..`
 * escapes. Defense-in-depth — symbol indexes are bridge-generated,
 * but if a future scan ever produced a bad path we don't want to
 * blindly read it.
 */
function resolveSafely(appPath: string, rel: string): string | null {
  if (!rel || isAbsolute(rel)) return null;
  const abs = resolve(appPath, rel);
  const within = relative(appPath, abs);
  if (within.startsWith("..") || isAbsolute(within)) return null;
  return abs;
}

/**
 * Score a symbol entry against the task tokens. Counts substring
 * matches in BOTH the file path and the symbol name. We use
 * substring (not whole-word) so `formInput` is matched by `form`
 * and `useFormState` is matched by `form`.
 */
export function scoreSymbol(symbol: SymbolEntry, taskTokens: string[]): number {
  const haystack = (symbol.file + " " + symbol.name).toLowerCase();
  let score = 0;
  for (const tok of taskTokens) {
    if (haystack.includes(tok)) score += 1;
  }
  return score;
}

interface CandidateFile {
  file: string;
  /** Sum of scores from every symbol that lives in this file. */
  score: number;
}

/**
 * Aggregate symbols by file: a file's score is the sum of all its
 * symbols' scores against the task tokens. Files with no scoring
 * symbols are dropped. Returns descending-sorted candidates.
 */
export function pickCandidateFiles(
  symbols: SymbolEntry[],
  taskTokens: string[],
): CandidateFile[] {
  if (taskTokens.length === 0) return [];
  const fileScores = new Map<string, number>();
  for (const s of symbols) {
    const inc = scoreSymbol(s, taskTokens);
    if (inc === 0) continue;
    fileScores.set(s.file, (fileScores.get(s.file) ?? 0) + inc);
  }
  const out: CandidateFile[] = [];
  for (const [file, score] of fileScores) {
    if (score < MIN_SCORE) continue;
    out.push({ file, score });
  }
  out.sort((a, b) => b.score - a.score || a.file.localeCompare(b.file));
  return out;
}

function readCapped(absPath: string): { content: string; truncated: boolean } | null {
  try {
    const buf = readFileSync(absPath);
    const truncated = buf.byteLength > PER_FILE_CAP_BYTES;
    const content = buf.subarray(0, PER_FILE_CAP_BYTES).toString("utf8");
    return { content, truncated };
  } catch {
    return null;
  }
}

export interface AttachReferencesOptions {
  appPath: string;
  taskBody: string;
  symbolIndex: SymbolIndex | null;
  /** Files already pinned for this app — we skip them so we don't
   *  waste a slot duplicating pinned content. */
  excludePaths?: string[];
}

/**
 * Public entry. Returns up to `MAX_REFERENCES` files, scored by
 * task-body keyword overlap with their symbols. Returns `[]` when
 * the symbol index is missing/empty, the task body produces no
 * useful tokens, or no symbol scored above the threshold.
 */
export function attachReferences(opts: AttachReferencesOptions): ReferenceFile[] {
  const { appPath, taskBody, symbolIndex } = opts;
  if (!symbolIndex || symbolIndex.symbols.length === 0) return [];
  const tokens = tokenize(taskBody ?? "");
  if (tokens.length === 0) return [];

  const exclude = new Set((opts.excludePaths ?? []).map((p) => p.replace(/\\/g, "/")));
  const candidates = pickCandidateFiles(symbolIndex.symbols, tokens);

  const out: ReferenceFile[] = [];
  for (const c of candidates) {
    if (out.length >= MAX_REFERENCES) break;
    const norm = c.file.replace(/\\/g, "/");
    if (exclude.has(norm)) continue;
    const abs = resolveSafely(appPath, c.file);
    if (!abs || !existsSync(abs)) continue;
    const read = readCapped(abs);
    if (!read) continue;
    out.push({
      rel: norm,
      content: read.content,
      truncated: read.truncated,
      score: c.score,
    });
  }
  return out;
}

export const __test = {
  tokenize,
  scoreSymbol,
  pickCandidateFiles,
  resolveSafely,
  PER_FILE_CAP_BYTES,
  MAX_REFERENCES,
  MIN_SCORE,
};
