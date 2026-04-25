/**
 * Apps registry — `bridge.json`.
 *
 * The bridge keeps user-declared apps (and any future bridge-level
 * settings) in `bridge.json` at the project root. JSON keeps parsing
 * trivial and the file is meant to be tracked in git so a team shares
 * the same workspace roster.
 *
 * Schema:
 *
 *   {
 *     "version": 1,
 *     "apps": [
 *       { "name": "app-web", "path": "../app-web", "description": "..." },
 *       { "name": "app-api", "path": "../app-api", "description": "..." }
 *     ]
 *   }
 *
 * `version` is reserved for future schema migrations. Only `apps[]`
 * is consumed today; additional top-level keys (e.g. `settings`) are
 * preserved on write so other modules can claim their own sections.
 *
 * Apps are addressed by `name`; names must match
 * `^[A-Za-z0-9][A-Za-z0-9._-]*$` (same shape as a folder slug). `path`
 * is stored verbatim — the caller resolves it against `BRIDGE_ROOT`
 * when needed.
 *
 * Legacy fallback: if `bridge.json` is missing but the old
 * `sessions/init.md` registry exists, we parse it on load so the
 * upgrade is transparent — the next `saveApps` rewrites the data as
 * JSON.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { BRIDGE_ROOT, SESSIONS_DIR } from "./paths";

export interface App {
  name: string;
  path: string;          // absolute, resolved against BRIDGE_ROOT
  rawPath: string;       // exactly what the user wrote (relative or absolute)
  description: string;
}

export interface BridgeManifest {
  version: number;
  apps: Array<{ name: string; path: string; description?: string }>;
  [key: string]: unknown;
}

const BRIDGE_JSON = join(BRIDGE_ROOT, "bridge.json");
const LEGACY_INIT_MD = join(SESSIONS_DIR, "init.md");
const APP_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const SCHEMA_VERSION = 1;

export function isValidAppName(name: unknown): name is string {
  return typeof name === "string" && APP_NAME_RE.test(name);
}

function resolveAppPath(rawPath: string): string {
  if (!rawPath) return rawPath;
  return isAbsolute(rawPath) ? resolve(rawPath) : resolve(BRIDGE_ROOT, rawPath);
}

function atomicWrite(path: string, contents: string): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  writeFileSync(tmp, contents);
  try {
    renameSync(tmp, path);
  } catch (err) {
    try { unlinkSync(tmp); } catch { /* ignore */ }
    throw err;
  }
}

/**
 * Read the raw manifest, preserving any unknown top-level keys so
 * write-modify-write cycles don't accidentally drop `settings`,
 * `experiments`, etc. that future modules might add.
 */
function readManifest(): BridgeManifest {
  if (!existsSync(BRIDGE_JSON)) {
    return { version: SCHEMA_VERSION, apps: [] };
  }
  try {
    const parsed = JSON.parse(readFileSync(BRIDGE_JSON, "utf8")) as Partial<BridgeManifest>;
    return {
      version: typeof parsed.version === "number" ? parsed.version : SCHEMA_VERSION,
      apps: Array.isArray(parsed.apps) ? parsed.apps : [],
      ...Object.fromEntries(
        Object.entries(parsed).filter(([k]) => k !== "version" && k !== "apps"),
      ),
    };
  } catch (err) {
    console.error("apps: bridge.json is unreadable — starting empty", err);
    return { version: SCHEMA_VERSION, apps: [] };
  }
}

function writeManifest(manifest: BridgeManifest): void {
  const ordered = {
    version: SCHEMA_VERSION,
    apps: manifest.apps,
    ...Object.fromEntries(
      Object.entries(manifest).filter(([k]) => k !== "version" && k !== "apps"),
    ),
  };
  atomicWrite(BRIDGE_JSON, JSON.stringify(ordered, null, 2) + "\n");
}

/** Public for tests — parse a manifest blob without touching disk. */
export function parseApps(json: string): App[] {
  if (!json || !json.trim()) return [];
  let parsed: Partial<BridgeManifest>;
  try { parsed = JSON.parse(json) as Partial<BridgeManifest>; }
  catch { return []; }
  if (!Array.isArray(parsed.apps)) return [];
  const out: App[] = [];
  for (const raw of parsed.apps) {
    if (!raw || typeof raw !== "object") continue;
    const name = (raw as { name?: unknown }).name;
    const rawPath = (raw as { path?: unknown }).path;
    const description = (raw as { description?: unknown }).description;
    if (!isValidAppName(name)) continue;
    if (typeof rawPath !== "string" || !rawPath.trim()) continue;
    out.push({
      name,
      rawPath,
      path: resolveAppPath(rawPath),
      description: typeof description === "string" ? description : "",
    });
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

/** Public for tests — render an apps list as a manifest JSON blob. */
export function serializeApps(apps: App[]): string {
  const manifest = {
    version: SCHEMA_VERSION,
    apps: apps.map((a) => {
      const entry: { name: string; path: string; description?: string } = {
        name: a.name,
        path: a.rawPath,
      };
      if (a.description.trim().length > 0) {
        entry.description = a.description.trim();
      }
      return entry;
    }),
  };
  return JSON.stringify(manifest, null, 2) + "\n";
}

/**
 * Soft-migration helper. Reads the legacy `sessions/init.md` markdown
 * format used in the previous version of the registry, surfacing
 * whatever `## <name>` sections it carried. Used only when
 * `bridge.json` is missing — the next `saveApps` writes JSON and
 * supersedes the .md.
 */
function readLegacyInitMd(): App[] {
  if (!existsSync(LEGACY_INIT_MD)) return [];
  let md: string;
  try { md = readFileSync(LEGACY_INIT_MD, "utf8"); }
  catch { return []; }
  const apps: App[] = [];
  const sections = md.split(/^##\s+/m).slice(1);
  for (const sec of sections) {
    const newlineIdx = sec.indexOf("\n");
    if (newlineIdx === -1) continue;
    const heading = sec.slice(0, newlineIdx).trim();
    const body = sec.slice(newlineIdx + 1);
    if (!APP_NAME_RE.test(heading)) continue;
    const pathMatch = body.match(/^[\s\-*]*\*\*Path:\*\*\s*`?([^`\n]+?)`?\s*$/im);
    if (!pathMatch) continue;
    const descMatch = body.match(/^[\s\-*]*\*\*Description:\*\*\s*(.+?)\s*$/im);
    const rawPath = pathMatch[1].trim();
    apps.push({
      name: heading,
      rawPath,
      path: resolveAppPath(rawPath),
      description: descMatch ? descMatch[1].trim() : "",
    });
  }
  apps.sort((a, b) => a.name.localeCompare(b.name));
  return apps;
}

export function loadApps(): App[] {
  if (existsSync(BRIDGE_JSON)) {
    return parseApps(readFileSync(BRIDGE_JSON, "utf8"));
  }
  return readLegacyInitMd();
}

export function saveApps(apps: App[]): void {
  const manifest = readManifest();
  manifest.apps = apps.map((a) => {
    const entry: { name: string; path: string; description?: string } = {
      name: a.name,
      path: a.rawPath,
    };
    if (a.description.trim().length > 0) entry.description = a.description.trim();
    return entry;
  });
  writeManifest(manifest);
}

export function getApp(name: string): App | null {
  if (!isValidAppName(name)) return null;
  return loadApps().find((a) => a.name === name) ?? null;
}

export interface AppInput {
  name: string;
  path: string;
  description?: string;
}

export interface AddAppResult {
  ok: true;
  app: App;
}

export interface AddAppFailure {
  ok: false;
  reason: "invalid-name" | "missing-path" | "duplicate-name";
}

export function addApp(input: AppInput): AddAppResult | AddAppFailure {
  if (!isValidAppName(input.name)) return { ok: false, reason: "invalid-name" };
  const rawPath = (input.path ?? "").trim();
  if (rawPath.length === 0) return { ok: false, reason: "missing-path" };
  const apps = loadApps();
  if (apps.some((a) => a.name === input.name)) {
    return { ok: false, reason: "duplicate-name" };
  }
  const app: App = {
    name: input.name,
    rawPath,
    path: resolveAppPath(rawPath),
    description: (input.description ?? "").trim(),
  };
  apps.push(app);
  apps.sort((a, b) => a.name.localeCompare(b.name));
  saveApps(apps);
  return { ok: true, app };
}

export function removeApp(name: string): boolean {
  if (!isValidAppName(name)) return false;
  const apps = loadApps();
  const next = apps.filter((a) => a.name !== name);
  if (next.length === apps.length) return false;
  saveApps(next);
  return true;
}

const REPO_MARKERS = [
  "package.json", "pyproject.toml", "requirements.txt",
  "go.mod", "Cargo.toml", "pom.xml", "build.gradle", "build.gradle.kts",
  "tsconfig.json", "Gemfile", "composer.json", ".git",
];

const SKIP_DIRS = new Set([
  "node_modules", ".git", ".vscode", ".idea", "dist", "build",
  ".next", "out", ".turbo", ".cache", ".pnpm-store", ".bridge-state",
  ".uploads", ".playwright-mcp", "coverage",
]);

function looksLikeCodeRepo(p: string): boolean {
  return REPO_MARKERS.some((m) => existsSync(join(p, m)));
}

function safeReadJson(p: string): { description?: string } | null {
  try { return JSON.parse(readFileSync(p, "utf8")) as { description?: string }; }
  catch { return null; }
}

function deriveDescription(repoPath: string): string {
  const pkg = safeReadJson(join(repoPath, "package.json"));
  if (pkg?.description) return pkg.description;
  for (const candidate of ["CLAUDE.md", "README.md", "readme.md"]) {
    try {
      const text = readFileSync(join(repoPath, candidate)).subarray(0, 1024).toString("utf8");
      const m = text.match(/^#\s+(.+)$/m);
      if (m) return m[1].trim().slice(0, 200);
    } catch { /* ignore */ }
  }
  return "";
}

export interface AutoDetectResult {
  added: App[];
  skipped: { name: string; reason: "already-registered" | "not-a-repo" }[];
}

/**
 * Scan the parent directory for sibling code repos and add any that
 * aren't already registered. The bridge folder itself is always
 * skipped. Returns the diff so the UI can toast a summary.
 */
export function autoDetectApps(): AutoDetectResult {
  const parent = dirname(BRIDGE_ROOT);
  const bridgeName = basename(BRIDGE_ROOT);
  const existing = loadApps();
  const known = new Set(existing.map((a) => a.name));
  const added: App[] = [];
  const skipped: AutoDetectResult["skipped"] = [];

  let entries: import("node:fs").Dirent[];
  try {
    entries = readdirSync(parent, { withFileTypes: true });
  } catch (err) {
    console.error("auto-detect: cannot read parent", parent, err);
    return { added, skipped };
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name === bridgeName) continue;
    if (entry.name.startsWith(".")) continue;
    if (SKIP_DIRS.has(entry.name)) continue;
    if (!APP_NAME_RE.test(entry.name)) continue;
    const repoPath = join(parent, entry.name);
    if (!looksLikeCodeRepo(repoPath)) {
      skipped.push({ name: entry.name, reason: "not-a-repo" });
      continue;
    }
    if (known.has(entry.name)) {
      skipped.push({ name: entry.name, reason: "already-registered" });
      continue;
    }
    const rawPath = `../${entry.name}`;
    const description = deriveDescription(repoPath);
    const app: App = {
      name: entry.name,
      rawPath,
      path: repoPath,
      description,
    };
    added.push(app);
    known.add(entry.name);
  }

  if (added.length > 0) {
    const next = [...existing, ...added].sort((a, b) => a.name.localeCompare(b.name));
    saveApps(next);
  }

  return { added, skipped };
}
