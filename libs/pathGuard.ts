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

export function validateAppPath(rawPath: string): PathGuardResult {
  const path = rawPath.trim();
  if (!path) return { ok: false, reason: "empty" };
  if (path.length > PATH_MAX_BYTES) {
    return { ok: false, reason: "empty", detail: "path too long" };
  }
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
