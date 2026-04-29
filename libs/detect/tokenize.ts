/**
 * Single bilingual tokenizer + stopword set used by every detector
 * surface. Replaces the three independent tokenize/stopword pairs that
 * existed before:
 *   - `lib/repoProfile.tokenize` (English-only, code-token oriented)
 *   - `lib/repoHeuristic` (no tokenizer, just substring `indexOf`)
 *   - `lib/contextAttach.tokenize` (English-only, prompt-shaped)
 *
 * Vietnamese support: we don't try real word segmentation (would need
 * a dictionary). Instead we strip diacritics and split on whitespace —
 * Vietnamese is written with spaces between syllables, so this gives
 * us per-syllable tokens that match the heuristic's needs ("khóa học"
 * → ["khoa", "hoc"] which can be matched against feature vocab).
 *
 * The bilingual stopword set covers the most common filler words in
 * both languages so a task like "Thêm trang đăng nhập" doesn't waste
 * keyword slots on "thêm" / "trang".
 */

/**
 * Strip Vietnamese (and other Latin-script) diacritics so "khóa" →
 * "khoa", "đăng" → "dang". Uses NFD decomposition + the combining-marks
 * Unicode block (U+0300–U+036F) + the special `đ` → `d` / `Đ` → `D`
 * rule (the only Vietnamese letter that doesn't decompose to a base
 * ASCII letter under NFD).
 */
export function stripDiacritics(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D");
}

/**
 * Bilingual stopword set. Skip words that carry no signal in either
 * language. Includes:
 *   - English fillers: the, and, of, to, …
 *   - Vietnamese fillers (post-diacritic-strip): va, cua, cho, la, …
 *   - Common verb prefixes used in tasks but uninformative about scope:
 *     add, fix, update, refactor, build, sua, them, cap nhat, …
 *   - Programming meta-words that appear everywhere: function, feature,
 *     code, file, page, task, …
 *
 * Always check tokens AFTER `stripDiacritics` + lowercase, so we only
 * need to list ASCII forms here.
 */
export const STOPWORDS = new Set<string>([
  // English fillers
  "the", "and", "of", "to", "for", "with", "this", "that",
  "are", "be", "as", "or", "at", "from", "it", "its",
  "but", "not", "no", "so", "do", "does", "did", "done", "have",
  "has", "had", "will", "would", "should", "can", "could", "may", "might",
  "into", "out", "off", "over", "under", "than", "then", "when", "where",
  "what", "who", "how", "why", "all", "any", "some", "these", "those",
  // Vietnamese fillers (post-diacritic-strip).
  // NOTE: we do NOT include "dang" / "nhap" / "ky" / "hoc" here even
  // though some of them have filler senses ("dang" = currently),
  // because they're load-bearing in the auth + lms feature vocab
  // ("dang nhap" = login, "khoa hoc" = course, "hoc vien" = student).
  "cua", "cho", "thi", "trong", "nay", "kia", "duoc",
  "neu", "nhu", "khi", "den", "voi", "boi",
  "khong", "chua", "moi", "ban", "minh", "toi",
  "anh", "chi", "ai", "nao", "sao", "vay",
  "rang", "phai", "muon", "len", "xuong", "vao",
  "qua", "lai", "luon", "van", "cung", "rat", "lam",
  // Action verbs (English)
  "add", "fix", "create", "make", "use", "remove",
  "delete", "change", "edit", "implement", "refactor", "review",
  "check", "verify", "ship", "deploy", "merge", "rebase", "update",
  // Action verbs (Vietnamese, post-diacritic-strip)
  "them", "sua", "xoa", "tao", "kiem", "tra",
  "trien", "khai", "viet", "doc", "chay", "thuc", "hien",
  "hoan", "thanh", "duyet",
  // Programming meta-words
  "task", "todo", "need", "needs", "want", "wants",
  "please", "function", "feature", "code", "file", "page", "trang",
  "src", "lib", "public", "dist",
  "tests", "spec", "specs", "config", "configs", "json",
  "tsx", "jsx", "mjs",
  "package", "lock", "readme", "license", "docs",
  "tinh", "nang", "chuc", "muc", "phan",
]);

/**
 * Tokenize free-form text into normalized lowercase tokens. The pipeline:
 *   1. Lowercase
 *   2. Strip Vietnamese diacritics (so "khóa học" matches "khoa hoc")
 *   3. Split on non-alphanumeric runs
 *   4. Drop tokens shorter than 3 chars, pure-numeric tokens, stopwords
 *
 * Returns deduped tokens in encounter order. Use this for ANY detection
 * surface so all impls see the same vocabulary.
 *
 * Note: profile keywords (which are stored unstripped) MUST be matched
 * against the stripped form too via `stripDiacritics(profileKw)` before
 * calling `countMatches` — this function strips internally only on its
 * own input.
 */
export function tokenize(text: string): string[] {
  if (!text) return [];
  const normalized = stripDiacritics(text.toLowerCase());
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of normalized.split(/[^a-z0-9]+/g)) {
    const t = raw.trim();
    if (!t || t.length < 3) continue;
    if (/^\d+$/.test(t)) continue;
    if (STOPWORDS.has(t)) continue;
    if (seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out;
}

/**
 * Generate adjacent bigram tokens from a tokenized list. Useful for
 * matching multi-word features ("dang nhap" = "đăng nhập" = login).
 * We only generate adjacent bigrams in the original token order —
 * anything smarter would need real NLP.
 */
export function bigrams(tokens: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i + 1 < tokens.length; i++) {
    out.push(`${tokens[i]} ${tokens[i + 1]}`);
  }
  return out;
}

/**
 * Count occurrences of `needle` in `haystack` after both have been
 * normalized via the same pipeline (lowercase + diacritic-strip).
 * Replaces the raw `indexOf`-based `countOccurrences` from
 * `repoHeuristic.ts` so all matching uses the diacritic-folded form.
 *
 * Stopwords are NOT filtered here — needles may legitimately be
 * stopwords (e.g. profile keywords). Caller decides relevance.
 */
export function countMatches(haystack: string, needle: string): number {
  if (!needle) return 0;
  const h = stripDiacritics(haystack.toLowerCase());
  const n = stripDiacritics(needle.toLowerCase());
  if (!n) return 0;
  let from = 0;
  let count = 0;
  while (true) {
    const idx = h.indexOf(n, from);
    if (idx === -1) break;
    count += 1;
    from = idx + n.length;
  }
  return count;
}

/** Internal helpers exposed for testing only. */
export const __test = {
  STOPWORDS_SIZE: STOPWORDS.size,
};
