/**
 * P3a / B3 — pinned-file loader.
 *
 * For each app, the operator can pin a small list of repo-relative
 * paths in `bridge.json.apps[].pinnedFiles` that the bridge MUST
 * inject into every spawned child's prompt — canonical examples,
 * routing manifests, type files, anything an agent should see without
 * burning a Read tool call to discover.
 *
 * Per-file cap (4 KB) + global cap on count (8) keep prompts bounded
 * even when an operator pins something huge by accident. Files that
 * don't exist or fall outside the app root (path-traversal attempt)
 * are silently skipped — never an error, since `pinnedFiles` is
 * operator-controlled config and a missing file is a soft failure
 * (rename / refactor) the bridge shouldn't escalate.
 */
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";

const PER_FILE_CAP_BYTES = 4 * 1024;
const MAX_FILES = 8;

export interface PinnedFile {
  /** Path relative to app root, posix-style. */
  rel: string;
  /** File contents, capped at `PER_FILE_CAP_BYTES`. Truncated marker
   *  appended on overflow. */
  content: string;
  truncated: boolean;
}

/**
 * Resolve a single pinned path safely against the app root: rejects
 * absolute paths, and rejects relative paths that resolve outside the
 * app dir (defense against `../../etc/passwd` in `bridge.json`). Both
 * checks return `null` so callers can `for ... of ... continue` on a
 * bad entry without abandoning the whole list.
 */
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

/**
 * Load the configured pinned files for an app. Returns at most
 * `MAX_FILES` entries, each capped at `PER_FILE_CAP_BYTES`. Missing
 * files / unsafe paths are skipped silently. Returns `[]` when the
 * app has no `pinnedFiles` configured — callers gate the UI section
 * on `result.length > 0`.
 */
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

// Internal exports for tests.
export const __test = {
  PER_FILE_CAP_BYTES,
  MAX_FILES,
  resolveSafely,
};
