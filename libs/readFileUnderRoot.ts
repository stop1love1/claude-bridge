import { closeSync, existsSync, openSync, readSync, statSync } from "node:fs";
import { join, resolve, sep } from "node:path";

/**
 * Reads a text file confined to a root directory. Shared by the per-app and
 * per-repo file routes so the traversal, binary and size guards exist once.
 */

const DEFAULT_MAX_BYTES = 1024 * 1024;
const BINARY_SCAN = 8192;

export type ReadFileFailure =
  | "invalid-path"
  | "not-found"
  | "not-a-file"
  | "binary"
  | "stat-failed";

export type ReadFileResult =
  | { ok: true; path: string; content: string; size: number; truncated: boolean }
  | { ok: false; reason: ReadFileFailure };

function parseRelParts(raw: string | null | undefined): string[] | null {
  if (raw == null || raw === "" || raw === ".") return null;
  const s = raw.replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/+$/, "");
  if (!s) return null;
  const parts = s.split("/").filter(Boolean);
  for (const p of parts) {
    if (p === "." || p === "..") return null;
    if (p.includes("\0")) return null;
    if (p.length > 240) return null;
  }
  if (parts.length === 0 || parts.length > 64) return null;
  return parts;
}

function absoluteUnderRoot(root: string, parts: string[]): string | null {
  const base = resolve(root);
  const target = resolve(join(base, ...parts));
  const prefix = base.endsWith(sep) ? base : base + sep;
  if (target !== base && !target.startsWith(prefix)) return null;
  return target;
}

function looksBinary(buf: Buffer): boolean {
  const n = Math.min(BINARY_SCAN, buf.length);
  for (let i = 0; i < n; i++) {
    if (buf[i] === 0) return true;
  }
  return false;
}

export function readFileUnderRoot(
  root: string,
  rawPath: string | null | undefined,
  opts: { maxBytes?: number } = {},
): ReadFileResult {
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const parts = parseRelParts(rawPath);
  if (!parts) return { ok: false, reason: "invalid-path" };

  const abs = absoluteUnderRoot(root, parts);
  if (!abs) return { ok: false, reason: "invalid-path" };
  if (!existsSync(abs)) return { ok: false, reason: "not-found" };

  let st;
  try {
    st = statSync(abs);
  } catch {
    return { ok: false, reason: "stat-failed" };
  }
  if (!st.isFile()) return { ok: false, reason: "not-a-file" };

  const toRead = Math.min(st.size, maxBytes);
  const fd = openSync(abs, "r");
  try {
    const buf = Buffer.allocUnsafe(toRead);
    readSync(fd, buf, 0, toRead, 0);
    if (looksBinary(buf)) return { ok: false, reason: "binary" };
    return {
      ok: true,
      path: parts.join("/"),
      content: buf.toString("utf8"),
      size: st.size,
      truncated: st.size > toRead,
    };
  } finally {
    closeSync(fd);
  }
}
