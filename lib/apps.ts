/**
 * Apps registry — `sessions/init.md`.
 *
 * The bridge no longer reads `BRIDGE.md` to discover sibling apps. Each
 * developer declares their workspace explicitly through the UI ("Add
 * app" form + "Auto-detect" button), and this module owns the read /
 * write of `sessions/init.md` as the source of truth.
 *
 * File format — strict so the parser is round-trip stable:
 *
 *   # Apps
 *
 *   > Managed by the Bridge UI. Edit via "Add app" / "Auto-detect"
 *   > buttons in the dashboard.
 *
 *   ## <name>
 *   - **Path:** `<absolute-or-relative-path>`
 *   - **Description:** <single-line description, optional>
 *
 *   ## <other-name>
 *   - **Path:** ...
 *   - **Description:** ...
 *
 * Apps are addressed by their `name`; names must match
 * `^[A-Za-z0-9][A-Za-z0-9._-]*$` (same shape as a folder slug). Path is
 * stored verbatim — the caller resolves it against `BRIDGE_ROOT` when
 * needed.
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

const INIT_MD = join(SESSIONS_DIR, "init.md");
const APP_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function isValidAppName(name: unknown): name is string {
  return typeof name === "string" && APP_NAME_RE.test(name);
}

function resolveAppPath(rawPath: string): string {
  if (!rawPath) return rawPath;
  return isAbsolute(rawPath) ? resolve(rawPath) : resolve(BRIDGE_ROOT, rawPath);
}

const HEADER_LINES = [
  "# Apps",
  "",
  "> Managed by the Bridge UI. Edit via \"Add app\" / \"Auto-detect\"",
  "> buttons in the dashboard. Hand-edits to this file are preserved",
  "> as long as each `## <name>` section keeps the documented shape.",
  "",
];

export function serializeApps(apps: App[]): string {
  const lines: string[] = [...HEADER_LINES];
  for (const app of apps) {
    lines.push(`## ${app.name}`);
    lines.push(`- **Path:** \`${app.rawPath}\``);
    if (app.description.trim().length > 0) {
      lines.push(`- **Description:** ${app.description.trim()}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

/**
 * Parse `sessions/init.md`. Tolerant of extra prose before the first
 * `## <name>` heading (e.g. legacy snapshots written by the old
 * `scripts/init.mjs` we removed) — only the strict h2-section blocks
 * with both `Path:` and a name regex match are surfaced.
 */
export function parseApps(md: string): App[] {
  const apps: App[] = [];
  if (!md) return apps;
  const sections = md.split(/^##\s+/m).slice(1); // first chunk is the preamble
  for (const sec of sections) {
    const newlineIdx = sec.indexOf("\n");
    if (newlineIdx === -1) continue;
    const heading = sec.slice(0, newlineIdx).trim();
    const body = sec.slice(newlineIdx + 1);
    if (!APP_NAME_RE.test(heading)) continue;
    const rawPath = matchField(body, /^[\s\-*]*\*\*Path:\*\*\s*`?([^`\n]+?)`?\s*$/im);
    if (!rawPath) continue;
    const description = matchField(body, /^[\s\-*]*\*\*Description:\*\*\s*(.+?)\s*$/im) ?? "";
    apps.push({
      name: heading,
      path: resolveAppPath(rawPath),
      rawPath,
      description,
    });
  }
  // Stable order for round-trip; UI sorts on its own.
  apps.sort((a, b) => a.name.localeCompare(b.name));
  return apps;
}

function matchField(text: string, re: RegExp): string | null {
  const m = text.match(re);
  return m ? m[1].trim() : null;
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

export function loadApps(): App[] {
  if (!existsSync(INIT_MD)) return [];
  try {
    return parseApps(readFileSync(INIT_MD, "utf8"));
  } catch (err) {
    console.error("apps: failed to parse sessions/init.md", err);
    return [];
  }
}

export function saveApps(apps: App[]): void {
  atomicWrite(INIT_MD, serializeApps(apps));
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
  // Read up to ~256 bytes from CLAUDE.md / README.md to grab the first
  // heading as a description hint.
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
 * aren't already registered. The bridge folder itself is always skipped
 * (it's not an "app" the coordinator dispatches to). Returns the diff
 * so the UI can toast a summary.
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
