import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import type { SymbolIndex, SymbolEntry } from "./symbolIndex";

const PER_FILE_CAP_BYTES = 4 * 1024;
const MAX_REFERENCES = 3;
const MIN_SCORE = 2;
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
  score: number;
}

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

function resolveSafely(appPath: string, rel: string): string | null {
  if (!rel || isAbsolute(rel)) return null;
  const abs = resolve(appPath, rel);
  const within = relative(appPath, abs);
  if (within.startsWith("..") || isAbsolute(within)) return null;
  return abs;
}

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
  score: number;
}

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
  excludePaths?: string[];
}

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
