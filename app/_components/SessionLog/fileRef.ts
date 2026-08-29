export interface FileRef {
  /** Repo-relative path, exactly as written. */
  path: string;
  /** 1-based line to scroll to, when the href carried one. */
  line?: number;
}

/**
 * Recognises the repo-relative file references agents write in prose, e.g.
 * `libs/validate.ts#L81` or `app/api/sessions/[sessionId]/route.ts#L12-L20`.
 *
 * Returns null for anything the in-chat viewer must not be handed: absolute
 * paths, parent-directory escapes, and anything carrying a scheme — the
 * markdown anchor keeps sending those down its existing path instead.
 */
export function parseFileRef(href: string | undefined | null): FileRef | null {
  if (!href) return null;
  // A scheme, a protocol-relative URL, or a query string is not a file ref.
  if (/^[a-z][a-z0-9+.-]*:/i.test(href)) return null;
  if (href.startsWith("//")) return null;
  if (href.includes("?")) return null;

  const hashAt = href.indexOf("#");
  const rawPath = hashAt === -1 ? href : href.slice(0, hashAt);
  const anchor = hashAt === -1 ? "" : href.slice(hashAt + 1);
  if (!rawPath) return null;

  // Repo-relative only: no absolute paths, no drive letters, no traversal.
  if (rawPath.startsWith("/") || rawPath.startsWith("\\")) return null;
  if (/^[a-zA-Z]:[\\/]/.test(rawPath)) return null;
  const segments = rawPath.split(/[\\/]/);
  if (segments.some((s) => s === "..")) return null;

  const lineMatch = /^L(\d+)/.exec(anchor);
  const line = lineMatch ? Number(lineMatch[1]) : 0;
  return line > 0 ? { path: rawPath, line } : { path: rawPath };
}
