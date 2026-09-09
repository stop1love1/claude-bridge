import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { readFileSync, readdirSync, statSync, type Dirent } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

/**
 * What the working tree already looked like when a run was dispatched, so the
 * claim-vs-diff gate can ask "what did *this* run change" instead of "what is
 * dirty right now".
 *
 * The bridge runs several children per task against one shared tree and only
 * auto-commits at the end, so by the time a `reviewer` or `ui-tester` finishes,
 * the `coder` that ran before it has left the tree full of changes. Without a
 * baseline the gate reads a truthful `## Changed files: (none — analysis only)`
 * as "reported no changes but git shows 11 touched files — likely silent
 * edits" and sends a read-only agent back for a retry it cannot pass.
 *
 * Paths alone are not enough: a run that further edits a file its predecessor
 * had already dirtied would hide inside the baseline. Hence a digest per path.
 */
export interface DiffBaseline {
  capturedAt: string;
  /**
   * Normalised path → content digest at capture time. `null` means the path
   * was dirty but had no readable content (deleted, or a directory entry), and
   * compares equal only to another `null`.
   */
  files: Record<string, string | null>;
}

const execFileP = promisify(execFile);
const GIT_TIMEOUT_MS = 5000;
/** Above this, hash the size instead of the bytes — big blobs are rarely source. */
const HASH_CAP_BYTES = 2 * 1024 * 1024;
/** A tree this dirty is not a baseline worth trusting; degrade instead. */
const MAX_BASELINE_FILES = 1000;

// ---------------------------------------------------------------------------
// `git status --porcelain=v1` parsing
// ---------------------------------------------------------------------------

const PORCELAIN_PREFIX_LEN = 3;
const PORCELAIN_STATUS_CODES = " MTADRCU?!";
const RENAME_ARROW = " -> ";

const C_ESCAPE_BYTES: Record<string, number> = {
  a: 0x07,
  b: 0x08,
  f: 0x0c,
  n: 0x0a,
  r: 0x0d,
  t: 0x09,
  v: 0x0b,
  '"': 0x22,
  "\\": 0x5c,
};

function unquotePorcelainPath(token: string): string {
  if (token.length < 2) return token;
  if (!token.startsWith('"') || !token.endsWith('"')) return token;

  const chars = Array.from(token.slice(1, -1));
  const encoder = new TextEncoder();
  const bytes: number[] = [];
  let i = 0;

  while (i < chars.length) {
    const ch = chars[i];
    if (ch !== "\\") {
      for (const byte of encoder.encode(ch)) bytes.push(byte);
      i += 1;
      continue;
    }
    const next = chars[i + 1];
    if (next === undefined) {
      bytes.push(C_ESCAPE_BYTES["\\"]);
      i += 1;
      continue;
    }
    const simple = C_ESCAPE_BYTES[next];
    if (simple !== undefined) {
      bytes.push(simple);
      i += 2;
      continue;
    }
    const octal = chars.slice(i + 1, i + 1 + 3).join("");
    if (/^[0-7]{3}$/.test(octal)) {
      bytes.push(parseInt(octal, 8));
      i += 4;
      continue;
    }
    for (const byte of encoder.encode(next)) bytes.push(byte);
    i += 2;
  }

  return new TextDecoder().decode(new Uint8Array(bytes));
}

function parsePorcelainLine(rawLine: string): string | null {
  const line = rawLine.replace(/\r+$/, "");
  if (line.length <= PORCELAIN_PREFIX_LEN) return null;
  if (line[PORCELAIN_PREFIX_LEN - 1] !== " ") return null;

  const x = line[0];
  const y = line[1];
  if (!PORCELAIN_STATUS_CODES.includes(x)) return null;
  if (!PORCELAIN_STATUS_CODES.includes(y)) return null;
  if (x === " " && y === " ") return null;

  const rest = line.slice(PORCELAIN_PREFIX_LEN);
  const isRename = x === "R" || x === "C" || y === "R" || y === "C";
  let token = rest;
  if (isRename) {
    const parts = rest.split(RENAME_ARROW);
    token = parts[1] ?? parts[0];
  }

  const path = unquotePorcelainPath(token);
  return path.length > 0 ? path : null;
}

export function parsePorcelainV1(stdout: string): string[] {
  const collected = new Set<string>();
  for (const rawLine of stdout.split(/\r?\n/)) {
    const path = parsePorcelainLine(rawLine);
    if (path !== null) collected.add(path);
  }
  return [...collected];
}

export function normPath(p: string): string {
  return p.replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "");
}

export async function readDirtyFiles(appPath: string): Promise<string[]> {
  try {
    const { stdout } = await execFileP("git", ["status", "--porcelain=v1"], {
      cwd: appPath,
      timeout: GIT_TIMEOUT_MS,
      windowsHide: true,
      maxBuffer: 256 * 1024,
    });
    return parsePorcelainV1(stdout);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Capture / compare
// ---------------------------------------------------------------------------

/** Cap on entries walked for one directory digest — see `directoryDigest`. */
const DIR_WALK_CAP = 2000;

/**
 * A digest of everything under an untracked directory: its files' paths and
 * sizes, sorted.
 *
 * `git status --porcelain` collapses a wholly-untracked directory into a
 * single `libs/` line instead of listing what is inside it. Digesting that
 * entry as "not a file" would make it compare equal to itself forever, so a
 * run that dropped another file into a directory its predecessor created would
 * slip through the gate.
 */
function directoryDigest(abs: string): string {
  const h = createHash("sha1");
  let walked = 0;
  const walk = (dir: string, prefix: string): void => {
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of [...entries].sort((a, b) => (a.name < b.name ? -1 : 1))) {
      if (walked >= DIR_WALK_CAP) return;
      walked += 1;
      const child = join(dir, e.name);
      if (e.isDirectory()) {
        walk(child, `${prefix}${e.name}/`);
        continue;
      }
      let size = -1;
      try { size = statSync(child).size; } catch { }
      h.update(`${prefix}${e.name}:${size}\n`);
    }
  };
  walk(abs, "");
  return `dir:${h.digest("hex")}`;
}

export function fileDigest(appPath: string, relPath: string): string | null {
  const abs = join(appPath, relPath);
  try {
    const st = statSync(abs);
    if (st.isDirectory()) return directoryDigest(abs);
    if (!st.isFile()) return null;
    if (st.size > HASH_CAP_BYTES) return `size:${st.size}`;
    return createHash("sha1").update(readFileSync(abs)).digest("hex");
  } catch {
    return null;
  }
}

/**
 * Snapshot the dirty paths of `appPath`. Returns `null` — meaning "no
 * baseline, fall back to comparing against the whole tree" — when git is
 * unavailable, the directory is not a repo, or the tree is so dirty that a
 * snapshot would be more noise than signal. Never throws: a run must not fail
 * to dispatch because the baseline could not be taken.
 */
export async function captureDiffBaseline(
  appPath: string,
): Promise<DiffBaseline | null> {
  try {
    const { stdout } = await execFileP("git", ["status", "--porcelain=v1"], {
      cwd: appPath,
      timeout: GIT_TIMEOUT_MS,
      windowsHide: true,
      maxBuffer: 256 * 1024,
    });
    const paths = parsePorcelainV1(stdout);
    if (paths.length > MAX_BASELINE_FILES) return null;
    const files: Record<string, string | null> = {};
    for (const p of paths) files[normPath(p)] = fileDigest(appPath, p);
    return { capturedAt: new Date().toISOString(), files };
  } catch {
    return null;
  }
}

/**
 * The subset of `actual` this run is answerable for: paths that were not dirty
 * at dispatch, plus paths that were dirty but whose contents have since moved.
 *
 * With no baseline the answer is `actual` unchanged, which is exactly the
 * behaviour every run had before baselines existed — so a failed capture, a
 * hand-registered run, or an older `meta.json` all degrade to the old gate
 * rather than to a gate that passes everything.
 */
export function attributableChanges(args: {
  actual: string[];
  baseline?: DiffBaseline | null;
  appPath: string;
}): string[] {
  const { actual, baseline, appPath } = args;
  if (!baseline || !baseline.files) return actual;
  return actual.filter((raw) => {
    const p = normPath(raw);
    if (!(p in baseline.files)) return true;
    return fileDigest(appPath, raw) !== baseline.files[p];
  });
}
