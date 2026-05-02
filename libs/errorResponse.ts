/**
 * Safe error-to-response conversion for API routes.
 *
 * Counterpart to `libs/apiResponse.ts` (success path). Together the two
 * modules form the bridge's API response contract:
 *
 *   - Success → `ok()` / `ok(payload)` from `apiResponse.ts`
 *   - Failure → `serverError(e, "context")` / `safeErrorMessage(e)` here
 *
 * Why this exists: pre-existing routes returned `String(e)` or
 * `e.message` directly in JSON. Both leak information the operator's
 * filesystem shouldn't put on the wire:
 *
 *   - `ENOENT: no such file or directory, open
 *      'D:/Edusoft/claude-bridge/.bridge-state/sessions/...'`
 *     → reveals the bridge's installed path and internal layout.
 *   - Stack traces include line numbers for installed code, which
 *     speeds up version-fingerprinting / CVE-style probing.
 *   - Some Error subclasses interpolate user input back into the
 *     message; an attacker who triggers a crafted error gets it
 *     reflected verbatim.
 *
 * This helper produces a stable, leak-free response body and pushes
 * the *full* error to `console.error` so the operator can still debug
 * from the server logs.
 *
 * Usage:
 *
 *   } catch (e) {
 *     return NextResponse.json(serverError(e, "sessions:create"), { status: 500 });
 *   }
 */

const FS_PATH_PATTERNS: Array<{ re: RegExp; replacement: string }> = [
  // Quoted path inside an Error message: ENOENT … open '/foo/bar'
  { re: /'(?:\/|[A-Za-z]:[\\/]|\\\\)[^'\n]*'/g, replacement: "'<path>'" },
  // Bare POSIX absolute path: starts at boundary, runs to whitespace.
  { re: /(^|\s|\()(\/[A-Za-z0-9_.\/-]+)/g, replacement: "$1<path>" },
  // Bare Windows absolute path: `D:\…` or `D:/…`.
  { re: /(^|\s|\()([A-Za-z]:[\\/][A-Za-z0-9_.\\\/ -]+)/g, replacement: "$1<path>" },
  // UNC path: `\\server\share\…`.
  { re: /(^|\s|\()(\\\\[^\s'"]+)/g, replacement: "$1<path>" },
];

/**
 * Strip absolute filesystem paths out of a free-form message. Idempotent
 * on inputs without paths. Order matters — the quoted-path rule must
 * run first because the bare-path rules would otherwise grab the
 * trailing quote.
 */
export function scrubPaths(s: string): string {
  let out = s;
  for (const { re, replacement } of FS_PATH_PATTERNS) {
    out = out.replace(re, replacement);
  }
  return out;
}

/**
 * Return a single short string suitable for emitting in an HTTP error
 * body. Strategy:
 *
 *   1. Prefer `e.code` when present (Node fs errors set `ENOENT`,
 *      `EACCES`, etc.) — these are already scrubbed and stable.
 *   2. Otherwise take only the first line of `e.message` (drops the
 *      stack) and run path scrubbing.
 *   3. Plain strings get scrubbed too.
 *   4. `null` / `undefined` / non-Error objects fall back to the
 *      caller's `fallback`, default `"internal_error"`.
 *
 * Length-capped at 200 chars so a hostile error can't smuggle
 * arbitrarily long payloads through the response.
 */
export function safeErrorMessage(e: unknown, fallback = "internal_error"): string {
  const cap = (s: string): string => (s.length > 200 ? s.slice(0, 197) + "…" : s);
  if (e == null) return fallback;
  // Node fs / system errors carry a stable `code` we can publish.
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

/**
 * Build a 500-level JSON body for a caught exception and log the full
 * error to stderr. `context` is a short tag that helps the operator
 * grep server logs (e.g. `"sessions:create"`, `"tasks:agent-spawn"`).
 */
export function serverError(e: unknown, context?: string): { error: string } {
  if (context) console.error(`[bridge] ${context} failed:`, e);
  else console.error("[bridge] error:", e);
  return { error: safeErrorMessage(e) };
}
