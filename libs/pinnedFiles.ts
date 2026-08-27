import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";

const PER_FILE_CAP_BYTES = 4 * 1024;
const MAX_FILES = 8;

export interface PinnedFile {
  rel: string;
  content: string;
  truncated: boolean;
}

function resolveSafely(appPath: string, rel: string): string | null {
  if (!rel || isAbsolute(rel)) return null;
  const abs = resolve(appPath, rel);
  const within = relative(appPath, abs);
  if (within.startsWith("..") || isAbsolute(within)) return null;
  return abs;
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

export function loadPinnedFiles(
  appPath: string,
  pinnedFiles: string[],
): PinnedFile[] {
  if (!appPath || !Array.isArray(pinnedFiles) || pinnedFiles.length === 0) {
    return [];
  }
  const out: PinnedFile[] = [];
  for (const raw of pinnedFiles) {
    if (out.length >= MAX_FILES) break;
    if (typeof raw !== "string") continue;
    const rel = raw.trim();
    if (!rel) continue;
    const abs = resolveSafely(appPath, rel);
    if (!abs || !existsSync(abs)) continue;
    const read = readCapped(abs);
    if (!read) continue;
    out.push({
      rel: rel.replace(/\\/g, "/"),
      content: read.content,
      truncated: read.truncated,
    });
  }
  return out;
}

export const __test = {
  PER_FILE_CAP_BYTES,
  MAX_FILES,
  resolveSafely,
};
