import { logError } from "./log";

const FS_PATH_PATTERNS: Array<{ re: RegExp; replacement: string }> = [
  { re: /'(?:\/|[A-Za-z]:[\\/]|\\\\)[^'\n]*'/g, replacement: "'<path>'" },
  { re: /(^|\s|\()(\/[A-Za-z0-9_.\/-]+)/g, replacement: "$1<path>" },
  { re: /(^|\s|\()([A-Za-z]:[\\/][A-Za-z0-9_.\\\/ -]+)/g, replacement: "$1<path>" },
  { re: /(^|\s|\()(\\\\[^\s'"]+)/g, replacement: "$1<path>" },
];

export function scrubPaths(s: string): string {
  let out = s;
  for (const { re, replacement } of FS_PATH_PATTERNS) {
    out = out.replace(re, replacement);
  }
  return out;
}

export function safeErrorMessage(e: unknown, fallback = "internal_error"): string {
  const cap = (s: string): string => (s.length > 200 ? s.slice(0, 197) + "…" : s);
  if (e == null) return fallback;
  const code = (e as { code?: unknown }).code;
  if (typeof code === "string" && /^[A-Z][A-Z0-9_]+$/.test(code)) return code;
  if (e instanceof Error) {
    const firstLine = (e.message ?? "").split(/\r?\n/)[0]?.trim() ?? "";
    if (!firstLine) return fallback;
    return cap(scrubPaths(firstLine)) || fallback;
  }
  if (typeof e === "string") {
    const firstLine = e.split(/\r?\n/)[0]?.trim() ?? "";
    return firstLine ? cap(scrubPaths(firstLine)) : fallback;
  }
  return fallback;
}

export function serverError(e: unknown, context?: string): { error: string } {
  if (context) logError("api", `${context} failed`, e);
  else logError("api", "error", e);
  return { error: safeErrorMessage(e) };
}
