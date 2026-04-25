/**
 * Upload safety helpers for `POST /api/sessions/[sessionId]/upload`.
 *
 * The bridge stages user-uploaded files at `<bridge>/.uploads/<sessionId>/`
 * and hands the absolute path back to the chat composer; the model
 * (Claude) can then `Read` or `Bash` against that path. That trust
 * boundary means:
 *
 *   1. We must never accept an executable extension. Even though the
 *      bridge itself doesn't execute uploads, a careless `Bash` tool
 *      call by the model would. Block the standard Windows + POSIX
 *      executable / scriptable extensions.
 *   2. Windows reserved device names (`CON`, `NUL`, `COM1`, …) cannot
 *      be created at all — and on legacy stacks they short-circuit to
 *      hardware. Reject them up-front.
 *   3. A trailing dot or space on Windows is silently stripped by the
 *      filesystem, opening trivial bypass tricks (`evil.exe.` is saved
 *      as `evil.exe`). Strip leading/trailing `.` and ` ` ourselves.
 *   4. The resolved write target must stay inside the upload dir.
 *
 * All helpers operate on the **already-sanitized** filename (Windows-
 * illegal chars replaced with `_`). The route runs that replacement
 * before calling us so the extension check matches the file actually
 * written to disk.
 */

import { resolve, sep } from "node:path";

/**
 * 25 MB ceiling on `Content-Length` / `file.size`. Big enough for
 * screenshots and small documents; small enough that a hostile client
 * can't OOM the bridge by streaming gigabytes through `formData()`.
 */
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

/**
 * Lower-case extension blocklist (with leading `.`). Matches the
 * sanitized filename's last `.<ext>` segment, case-insensitive. This
 * is intentionally inclusive — a `.dll` upload is uncommon enough that
 * blocking it is fine, and a hostile chain (`Read` → exec via shim)
 * isn't worth the convenience.
 */
export const BLOCKED_EXTENSIONS: ReadonlySet<string> = new Set([
  // Windows native executables / installers
  ".exe", ".bat", ".cmd", ".com", ".scr", ".msi", ".msp",
  ".dll", ".sys", ".lnk",
  // PowerShell / VBScript / WScript
  ".ps1", ".psm1", ".psd1",
  ".vbs", ".vbe", ".wsf", ".wsh",
  // JavaScript-on-disk variants (browser-side `.js` is fine; Windows'
  // wscript will execute it, so refuse to land it on disk).
  ".js", ".jse",
  // POSIX shells
  ".sh",
]);

/**
 * Windows reserved device names (case-insensitive). Match against the
 * filename's stem — i.e. the part before the first dot — because
 * `CON.txt` is reserved on Windows just like `CON`.
 */
const RESERVED_DEVICE_NAMES: ReadonlySet<string> = new Set([
  "con", "prn", "aux", "nul",
  "com1", "com2", "com3", "com4", "com5", "com6", "com7", "com8", "com9",
  "lpt1", "lpt2", "lpt3", "lpt4", "lpt5", "lpt6", "lpt7", "lpt8", "lpt9",
]);

export type UploadGuardResult =
  | { ok: true; sanitized: string }
  | { ok: false; reason: UploadGuardReason; detail?: string };

export type UploadGuardReason =
  | "empty-name"
  | "blocked-extension"
  | "reserved-name"
  | "outside-upload-dir";

/**
 * Strip illegal Windows characters and surrounding `.` / spaces from a
 * raw filename. Returns the empty string when nothing salvageable
 * remains; the caller turns that into `400 file required`.
 *
 * Mirrors the historical regex (`[\\/:*?"<>|]` → `_`) so older paths
 * already on disk continue to round-trip; the only added behavior is
 * the leading/trailing `.` / ` ` strip.
 */
export function sanitizeUploadName(raw: string): string {
  if (typeof raw !== "string") return "";
  // Replace Windows-illegal chars with `_` (same as the route did
  // before this helper existed).
  let cleaned = raw.replace(/[\\/:*?"<>|]/g, "_");
  // Drop leading/trailing dots and spaces — Windows silently strips
  // these and lets `evil.exe.` masquerade as `evil.exe`.
  cleaned = cleaned.replace(/^[.\s]+|[.\s]+$/g, "");
  return cleaned;
}

/**
 * Extract the lower-case extension (with leading dot) from a filename,
 * or empty string if none. Uses the LAST dot so `archive.tar.gz` → `.gz`.
 */
export function extractExtension(name: string): string {
  const idx = name.lastIndexOf(".");
  if (idx <= 0) return ""; // no dot, or leading dot only (`.bashrc` → no ext)
  return name.slice(idx).toLowerCase();
}

/**
 * Stem of the filename, lower-cased, used to detect reserved device
 * names. `archive.tar.gz` → `archive`; `CON.txt` → `con`.
 */
function extractStem(name: string): string {
  const idx = name.indexOf(".");
  return (idx === -1 ? name : name.slice(0, idx)).toLowerCase();
}

export function hasBlockedExtension(name: string): boolean {
  const ext = extractExtension(name);
  return ext.length > 0 && BLOCKED_EXTENSIONS.has(ext);
}

export function isReservedDeviceName(name: string): boolean {
  return RESERVED_DEVICE_NAMES.has(extractStem(name));
}

/**
 * Single-shot validator: sanitize `raw`, then run every check in
 * order. Caller maps the failure reason onto an HTTP status.
 *
 * Path containment is checked separately via `assertInsideUploadDir`
 * because it requires the resolved upload directory.
 */
export function validateUploadName(raw: string): UploadGuardResult {
  const sanitized = sanitizeUploadName(raw);
  if (sanitized.length === 0) return { ok: false, reason: "empty-name" };
  if (isReservedDeviceName(sanitized)) {
    return { ok: false, reason: "reserved-name", detail: sanitized };
  }
  if (hasBlockedExtension(sanitized)) {
    return {
      ok: false,
      reason: "blocked-extension",
      detail: extractExtension(sanitized),
    };
  }
  return { ok: true, sanitized };
}

/**
 * Final defense-in-depth check on the resolved write path. Even with a
 * sanitized name, paranoia says: `path.resolve(dir, name).startsWith(dir + sep)`
 * has to hold, otherwise refuse the write. Catches any future regression
 * where the sanitization is loosened (e.g. someone re-allows `..` in names).
 */
export function assertInsideUploadDir(
  uploadDir: string,
  candidatePath: string,
): boolean {
  const resolvedDir = resolve(uploadDir);
  const resolvedCandidate = resolve(candidatePath);
  // Append `sep` so `/uploads/abc` doesn't accept `/uploads/abc-evil`.
  return (
    resolvedCandidate === resolvedDir ||
    resolvedCandidate.startsWith(resolvedDir + sep)
  );
}
