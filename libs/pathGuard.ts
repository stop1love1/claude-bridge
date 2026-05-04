/**
 * Filesystem-path validators used by routes / stores that accept a path
 * from the operator and then hand it to git, claude, exec, fs.read, …
 *
 * Two layers of defense:
 *   1. Charset / shape — reject null bytes, control chars, obvious garbage.
 *   2. Containment    — when `BRIDGE_ALLOWED_ROOTS` is set, the resolved
 *      absolute path must sit underneath one of the listed roots.
 *
 * `BRIDGE_ALLOWED_ROOTS` is a `;`-separated list of absolute directories
 * (Windows-friendly: `C:\dev\repos;D:\code`). Empty / unset means
 * "trust the operator", which is the default for localhost dev. Operators
 * exposing the bridge over a tunnel should set it explicitly so a
 * compromised cookie can't make `addApp` register `C:\Windows\System32`.
 */
import { existsSync, statSync } from "node:fs";
import { isAbsolute, resolve, sep } from "node:path";

export type PathGuardOk = { ok: true; resolvedPath: string };
export type PathGuardFail = {
  ok: false;
  reason:
    | "empty"
    | "control-char"
    | "not-absolute"
    | "missing"
    | "not-directory"
    | "outside-allowed-roots";
  detail?: string;
};
export type PathGuardResult = PathGuardOk | PathGuardFail;

/** Tunable knobs — exposed for tests. */
export const PATH_MAX_BYTES = 4096;

function getAllowedRoots(): string[] {
  const raw = process.env.BRIDGE_ALLOWED_ROOTS;
  if (!raw) return [];
  return raw
    .split(/[;]+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((p) => resolve(p));
}

function isInside(child: string, parent: string): boolean {
  const c = resolve(child);
  const p = resolve(parent);
  if (c === p) return true;
  const withSep = p.endsWith(sep) ? p : p + sep;
  return c.startsWith(withSep);
}

/**
 * Validate an app working-tree path supplied by the operator. Used by
 * `addApp` (POST /api/apps) and any future "edit app path" endpoint.
 *
 * Caller passes the raw string from the request body (already trimmed).
 * On success the caller stores `rawPath` as-is and uses `resolvedPath`
 * for `existsSync` / `spawn(cwd)` / etc.
 *
 * Two important notes:
 *   - Relative paths are accepted (resolved against `process.cwd()`),
 *     because the bridge UI's "Add app" flow lets the operator type a
 *     sibling-folder name like `../my-app`. Containment still applies
 *     after resolution, so `../../etc` still gets caught when
 *     `BRIDGE_ALLOWED_ROOTS` is set.
 *   - Existence is checked here so the route can reject early. Race vs
 *     post-validation `rmdir` is fine — downstream callers already gate
 *     `existsSync(cwd)` again before spawning.
 */
export function validateAppPath(rawPath: string): PathGuardResult {
  const path = rawPath.trim();
  if (!path) return { ok: false, reason: "empty" };
  if (path.length > PATH_MAX_BYTES) {
    return { ok: false, reason: "empty", detail: "path too long" };
  }
  // Reject NUL and ASCII control chars — these break path APIs in
  // platform-dependent ways (Windows treats `\0` as terminator, POSIX
  // refuses, both can confuse downstream tools).
  if (/[\x00-\x1f]/.test(path)) {
    return { ok: false, reason: "control-char" };
  }

  const resolvedPath = resolve(path);

  if (!existsSync(resolvedPath)) {
    return { ok: false, reason: "missing", detail: resolvedPath };
  }
  let stat;
  try {
    stat = statSync(resolvedPath);
  } catch (err) {
    return { ok: false, reason: "missing", detail: (err as Error).message };
  }
  if (!stat.isDirectory()) {
    return { ok: false, reason: "not-directory", detail: resolvedPath };
  }

  const allowed = getAllowedRoots();
  if (allowed.length > 0) {
    const inside = allowed.some((root) => isInside(resolvedPath, root));
    if (!inside) {
      return {
        ok: false,
        reason: "outside-allowed-roots",
        detail: `BRIDGE_ALLOWED_ROOTS=${allowed.join(";")}`,
      };
    }
  }

  return { ok: true, resolvedPath };
}

/**
 * Stricter variant for routes that ONLY accept absolute paths (e.g.
 * `repos/[name]/raw?path=` if it ever evolves). Mostly future-facing —
 * `validateAppPath` is what the current addApp flow needs.
 */
export function requireAbsolutePathInsideRoots(rawPath: string): PathGuardResult {
  const base = validateAppPath(rawPath);
  if (!base.ok) return base;
  if (!isAbsolute(rawPath.trim())) {
    return { ok: false, reason: "not-absolute" };
  }
  return base;
}

export function pathGuardMessage(reason: PathGuardFail["reason"]): string {
  switch (reason) {
    case "empty":
      return "path is required";
    case "control-char":
      return "path contains control characters";
    case "not-absolute":
      return "path must be absolute";
    case "missing":
      return "path does not exist";
    case "not-directory":
      return "path is not a directory";
    case "outside-allowed-roots":
      return "path is outside BRIDGE_ALLOWED_ROOTS";
  }
}
