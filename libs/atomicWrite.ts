/**
 * Shared atomic-write helper.
 *
 * Pre-Sprint-1, every store that persisted JSON to disk (`profileStore`,
 * `styleStore`, `symbolStore`, `meta`, `bridgeManifest`) reinvented the
 * same write-tmp-then-rename pattern. The earlier copies all used a
 * shared `${path}.tmp` suffix, which races: two concurrent writers stage
 * their payload to the same temp path, the second `writeFileSync` wins
 * the staging, and whichever rename hits the destination second wins the
 * overall write — but the loser's payload is silently dropped without
 * surfacing an error. The unique pid+timestamp+random suffix here makes
 * the staging path unique per call so concurrent writers can't trample
 * each other's tmp file.
 *
 * Other guarantees:
 *   - mkdir parent (recursive) before staging — callers used to do this
 *     manually and a third of them forgot.
 *   - rename failure unlinks the staged tmp before re-throwing, so a
 *     filesystem error doesn't leak `.tmp` files indefinitely.
 *   - optional POSIX mode: applied to the staged tmp BEFORE the rename
 *     (rename inherits the mode on Linux) and re-applied after the
 *     rename on macOS where some filesystems retain the destination
 *     inode's metadata across the rename. Skipped on Windows.
 *
 * Sprint 1 migrated the five known call sites to use this helper. New
 * code that needs an atomic file write should call into here rather
 * than reinventing the pattern.
 */
import {
  chmodSync,
  mkdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

export interface AtomicWriteOptions {
  /**
   * POSIX file mode to apply to the staged tmp file (and re-apply to
   * the destination after rename, which is a no-op on most filesystems
   * but matters on the macOS variants that preserve destination inode
   * metadata across `rename`). Ignored on Windows.
   */
  mode?: number;
}

function uniqueTmpPath(filePath: string): string {
  return `${filePath}.${process.pid}.${Date.now()}.${Math.random()
    .toString(36)
    .slice(2, 8)}.tmp`;
}

/**
 * Atomic write of a string payload.
 *
 * Stages to `${filePath}.<pid>.<ms>.<rand>.tmp` then renames. Renames
 * are atomic on POSIX and atomic-on-success on NTFS, so a crash mid-
 * write leaves either the old file or the new — never a partial.
 */
export function writeStringAtomic(
  filePath: string,
  content: string,
  opts?: AtomicWriteOptions,
): void {
  mkdirSync(dirname(filePath), { recursive: true });
  const tmp = uniqueTmpPath(filePath);
  // Apply mode at write time so the temp file (and the post-rename
  // destination) starts out with the requested permissions. On Windows
  // the option is ignored; pass it anyway since writeFileSync accepts
  // it cross-platform.
  const writeOpts =
    opts?.mode !== undefined ? { mode: opts.mode } : undefined;
  writeFileSync(tmp, content, writeOpts);
  try {
    renameSync(tmp, filePath);
  } catch (err) {
    try { unlinkSync(tmp); } catch { /* ignore — rename may have moved it */ }
    throw err;
  }
  // macOS' HFS / some APFS configurations preserve the destination
  // inode's metadata across rename, which would silently downgrade
  // the mode we set on the staged tmp file. Re-apply explicitly.
  // Skipped on Windows where chmod is largely a no-op and some
  // virtualized filesystems return EPERM.
  if (opts?.mode !== undefined && process.platform !== "win32") {
    try { chmodSync(filePath, opts.mode); } catch { /* best-effort */ }
  }
}

/**
 * Atomic write of a JSON-serializable value. Output uses 2-space
 * indentation and a trailing newline to match the on-disk convention
 * the legacy ad-hoc helpers established (so swapping callers over
 * doesn't churn diffs).
 */
export function writeJsonAtomic(
  filePath: string,
  value: unknown,
  opts?: AtomicWriteOptions,
): void {
  writeStringAtomic(filePath, JSON.stringify(value, null, 2) + "\n", opts);
}
