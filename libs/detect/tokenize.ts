
export function stripDiacritics(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D");
}

export const STOPWORDS = new Set<string>([
  "the", "and", "of", "to", "for", "with", "this", "that",
  "are", "be", "as", "or", "at", "from", "it", "its",
  "but", "not", "no", "so", "do", "does", "did", "done", "have",
  "has", "had", "will", "would", "should", "can", "could", "may", "might",
  "into", "out", "off", "over", "under", "than", "then", "when", "where",
  "what", "who", "how", "why", "all", "any", "some", "these", "those",
  "cua", "cho", "thi", "trong", "nay", "kia", "duoc",
  "neu", "nhu", "khi", "den", "voi", "boi",
  "khong", "chua", "moi", "ban", "minh", "toi",
  "anh", "chi", "ai", "nao", "sao", "vay",
  "rang", "phai", "muon", "len", "xuong", "vao",
  "qua", "lai", "luon", "van", "cung", "rat", "lam",
  "add", "fix", "create", "make", "use", "remove",
  "delete", "change", "edit", "implement", "refactor", "review",
  "check", "verify", "ship", "deploy", "merge", "rebase", "update",
  "them", "sua", "xoa", "tao", "kiem", "tra",
  "trien", "khai", "viet", "doc", "chay", "thuc", "hien",
  "hoan", "thanh", "duyet",
  "task", "todo", "need", "needs", "want", "wants",
  "please", "function", "feature", "code", "file", "page", "trang",
  "src", "lib", "public", "dist",
  "tests", "spec", "specs", "config", "configs", "json",
  "tsx", "jsx", "mjs",
  "package", "lock", "readme", "license", "docs",
  "tinh", "nang", "chuc", "muc", "phan",
]);

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

export function bigrams(tokens: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i + 1 < tokens.length; i++) {
    out.push(`${tokens[i]} ${tokens[i + 1]}`);
  }
  return out;
}

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

export const __test = {
  STOPWORDS_SIZE: STOPWORDS.size,
};
