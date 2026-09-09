import { statSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Turns a filesystem `EACCES`/`EPERM` into a sentence an operator can act on.
 *
 * The bridge stores its manifest in `$HOME/.claude/bridge.json`, and the most
 * common way that stops being writable on Linux is a single `sudo` run in the
 * past: root creates or takes over `~/.claude`, and every later run as the
 * normal user gets `EACCES`. Node's own message names the temp file and nothing
 * else, so the operator has to go stat the tree by hand. These helpers do that
 * stat and hand back the owner, the mode, and the exact `chown`/`chmod`.
 */

export interface FsStat {
  uid: number;
  gid: number;
  mode: number;
}

export interface DiagnoseDeps {
  platform?: NodeJS.Platform;
  statSync?: (p: string) => FsStat;
  /** Absent on Windows; passing `undefined` explicitly forces the non-POSIX branch. */
  getuid?: (() => number) | undefined;
  getgid?: (() => number) | undefined;
}

/**
 * Symbolic name for the manifest, used in HTTP bodies. Deliberately the literal
 * `~` form: it tells the operator which file to look at without disclosing the
 * host's home directory to whoever the bridge is exposed to.
 */
export const MANIFEST_LABEL = "~/.claude/bridge.json";

const PERMISSION_CODES = new Set(["EACCES", "EPERM"]);

/** Owner needs write+execute on a directory before a file can be created in it. */
const DIR_NEEDED = 0o300;
const FILE_NEEDED = 0o200;

export function errnoCode(err: unknown): string | null {
  if (err === null || typeof err !== "object") return null;
  const code = (err as NodeJS.ErrnoException).code;
  return typeof code === "string" ? code : null;
}

export function isPermissionError(err: unknown): boolean {
  const code = errnoCode(err);
  return code !== null && PERMISSION_CODES.has(code);
}

function fmtMode(mode: number): string {
  return (mode & 0o7777).toString(8).padStart(4, "0");
}

function statOrNull(p: string, stat: (p: string) => FsStat): FsStat | null {
  try {
    return stat(p);
  } catch {
    return null;
  }
}

/**
 * A full, path-bearing explanation meant for the bridge's own terminal log —
 * never for an HTTP body, which scrubs host paths on purpose.
 */
export function describeWriteFailure(
  filePath: string,
  err: unknown,
  deps: DiagnoseDeps = {},
): string {
  const code = errnoCode(err);
  const head = `${code ?? "write failed"} writing ${filePath}`;

  if (code === "EROFS") return `${head} — the filesystem is mounted read-only.`;
  if (code === "ENOSPC") return `${head} — the filesystem is full.`;
  if (code === null || !PERMISSION_CODES.has(code)) return head;

  const platform = deps.platform ?? process.platform;
  const stat = deps.statSync ?? ((p: string) => statSync(p) as FsStat);
  const getuid = "getuid" in deps ? deps.getuid : process.getuid?.bind(process);
  const getgid = "getgid" in deps ? deps.getgid : process.getgid?.bind(process);

  if (platform === "win32" || !getuid) {
    return `${head} — the file is read-only, or another process is holding it open.`;
  }

  const uid = getuid();
  const gid = getgid ? getgid() : 0;
  const me = `${uid}:${gid}`;
  const dir = dirname(filePath);

  const dirStat = statOrNull(dir, stat);
  if (!dirStat) {
    return `${head} — its directory ${dir} cannot be read by uid ${uid}; check every parent for a missing +x bit.`;
  }
  if (dirStat.uid !== uid) {
    return `${head} — its directory ${dir} is owned by ${dirStat.uid}:${dirStat.gid} but the bridge runs as ${me}. Fix: sudo chown -R ${me} ${dir}`;
  }
  if ((dirStat.mode & DIR_NEEDED) !== DIR_NEEDED) {
    return `${head} — its directory ${dir} is yours (${me}) but its mode is ${fmtMode(dirStat.mode)}. Fix: chmod u+rwx ${dir}`;
  }

  const fileStat = statOrNull(filePath, stat);
  if (fileStat && fileStat.uid !== uid) {
    return `${head} — that file is owned by ${fileStat.uid}:${fileStat.gid} but the bridge runs as ${me}. Fix: sudo chown ${me} ${filePath}`;
  }
  if (fileStat && (fileStat.mode & FILE_NEEDED) !== FILE_NEEDED) {
    return `${head} — that file is yours (${me}) but its mode is ${fmtMode(fileStat.mode)}. Fix: chmod u+w ${filePath}`;
  }

  return `${head} — uid ${uid} already owns the file and its directory with writable modes, so something outside the POSIX bits is blocking it: a read-only mount, an ACL (getfacl ${dir}), SELinux/AppArmor, or a container volume mapped to a different uid.`;
}

/**
 * The short, path-free counterpart safe to return over HTTP. `label` is a
 * symbolic location such as `~/.claude/bridge.json`, never a resolved path.
 * Returns `null` when the error is not about writability, so callers can fall
 * through to their generic error handling.
 */
export function writeFailureHint(label: string, err: unknown): string | null {
  const code = errnoCode(err);
  switch (code) {
    case "EACCES":
    case "EPERM":
      return `cannot write ${label} (${code}) — the bridge process has no write permission there; the bridge terminal log names the owner and the exact command that fixes it`;
    case "EROFS":
      return `cannot write ${label} (EROFS) — that filesystem is mounted read-only`;
    case "ENOSPC":
      return `cannot write ${label} (ENOSPC) — the filesystem is full`;
    default:
      return null;
  }
}
