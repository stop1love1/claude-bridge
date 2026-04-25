/**
 * Apps registry — `~/.claude/bridge.json`.
 *
 * The bridge keeps user-declared apps (and any future bridge-level
 * settings) alongside Claude Code's GLOBAL user config under
 * `$HOME/.claude/`. Storing it outside the bridge project means a
 * `git pull` / version upgrade on the bridge repo never touches the
 * operator's app roster — the file lives on the operator's machine,
 * not in the project tree.
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
import { BRIDGE_ROOT, USER_CLAUDE_DIR } from "./paths";

/**
 * Per-app git workflow settings, persisted alongside the app entry in
 * `bridge.json`. Drives how the bridge prepares the working tree before
 * dispatching a child agent and what it does afterwards. The defaults
 * match the historical behavior (work on whatever branch is checked
 * out, never auto-commit, never auto-push) so existing apps without
 * a `git` key behave exactly as before.
 */
export type GitBranchMode = "current" | "fixed" | "auto-create";

export interface AppGitSettings {
  /**
   * - `current`     — leave HEAD alone, agent works on whatever's checked out
   * - `fixed`       — switch to / create `fixedBranch` before each task
   * - `auto-create` — create a new task-scoped branch (e.g. `claude/<task-id>`)
   */
  branchMode: GitBranchMode;
  /** Branch name when `branchMode === "fixed"`. Empty otherwise. */
  fixedBranch: string;
  /** Run `git commit -am` after the task wraps up. */
  autoCommit: boolean;
  /** Run `git push` after `autoCommit`. Implies `autoCommit`. */
  autoPush: boolean;
}

export const DEFAULT_GIT_SETTINGS: AppGitSettings = {
  branchMode: "current",
  fixedBranch: "",
  autoCommit: false,
  autoPush: false,
};

/**
 * Per-app verify contract — shell commands the bridge runs after a
 * child agent finishes (Phase 2 of the agentic-coder roadmap). Each
 * field is a single shell command line; missing fields are skipped.
 *
 * P1 only loads + surfaces these into the child prompt as a `## Verify
 * commands` block so the agent knows how to self-check before writing
 * its report. P2 will exec them via `sh -c` after the run, attach
 * pass/fail to `meta.json`, and feed failures into the auto-retry path.
 */
export interface AppVerify {
  test?: string;
  lint?: string;
  build?: string;
  typecheck?: string;
  format?: string;
}

export const DEFAULT_VERIFY: AppVerify = {};

export interface App {
  name: string;
  path: string;          // absolute, resolved against BRIDGE_ROOT
  rawPath: string;       // exactly what the user wrote (relative or absolute)
  description: string;
  git: AppGitSettings;
  verify: AppVerify;
}

interface ManifestAppEntry {
  name: string;
  path: string;
  description?: string;
  git?: Partial<AppGitSettings>;
  verify?: AppVerify;
}

export interface BridgeManifest {
  version: number;
  apps: ManifestAppEntry[];
  [key: string]: unknown;
}

const BRIDGE_JSON = join(USER_CLAUDE_DIR, "bridge.json");
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

function normalizeGitSettings(raw: unknown): AppGitSettings {
  if (!raw || typeof raw !== "object") return { ...DEFAULT_GIT_SETTINGS };
  const r = raw as Partial<AppGitSettings>;
  const branchMode: GitBranchMode =
    r.branchMode === "fixed" || r.branchMode === "auto-create" ? r.branchMode : "current";
  const fixedBranch = typeof r.fixedBranch === "string" ? r.fixedBranch.trim() : "";
  const autoCommit = r.autoCommit === true || r.autoPush === true;
  const autoPush = r.autoPush === true;
  return { branchMode, fixedBranch, autoCommit, autoPush };
}

/**
 * Coerce arbitrary input into an `AppVerify`. Each field must be a
 * non-empty trimmed string — anything else is dropped. Returns `{}`
 * when nothing usable was provided (matches `DEFAULT_VERIFY`).
 */
function normalizeVerify(raw: unknown): AppVerify {
  if (!raw || typeof raw !== "object") return { ...DEFAULT_VERIFY };
  const r = raw as Partial<Record<keyof AppVerify, unknown>>;
  const out: AppVerify = {};
  for (const key of ["test", "lint", "build", "typecheck", "format"] as const) {
    const v = r[key];
    if (typeof v === "string") {
      const trimmed = v.trim();
      if (trimmed.length > 0) out[key] = trimmed;
    }
  }
  return out;
}

/**
 * Drop the `verify` key entirely when no commands are configured so old
 * `bridge.json` files stay terse — matches the `serializeGitSettings`
 * convention. Returns the trimmed AppVerify when at least one command
 * is set, `undefined` otherwise.
 */
function serializeVerify(v: AppVerify | undefined): AppVerify | undefined {
  if (!v) return undefined;
  const out: AppVerify = {};
  for (const key of ["test", "lint", "build", "typecheck", "format"] as const) {
    const cmd = v[key];
    if (typeof cmd === "string" && cmd.trim().length > 0) {
      out[key] = cmd.trim();
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function serializeGitSettings(g: AppGitSettings | undefined): Partial<AppGitSettings> | undefined {
  // Drop the key entirely when settings are at defaults so old bridge.json
  // files stay terse and `git`-aware diffs only fire when there's real
  // configuration to persist. Defensive against missing input so callers
  // that fabricate App objects without the field (legacy code, tests)
  // don't crash on serialize.
  if (!g) return undefined;
  const out: Partial<AppGitSettings> = {};
  if (g.branchMode !== DEFAULT_GIT_SETTINGS.branchMode) out.branchMode = g.branchMode;
  if (g.branchMode === "fixed" && g.fixedBranch.trim().length > 0) {
    out.fixedBranch = g.fixedBranch.trim();
  }
  if (g.autoCommit) out.autoCommit = true;
  if (g.autoPush) out.autoPush = true;
  return Object.keys(out).length > 0 ? out : undefined;
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
    const gitRaw = (raw as { git?: unknown }).git;
    const verifyRaw = (raw as { verify?: unknown }).verify;
    if (!isValidAppName(name)) continue;
    if (typeof rawPath !== "string" || !rawPath.trim()) continue;
    out.push({
      name,
      rawPath,
      path: resolveAppPath(rawPath),
      description: typeof description === "string" ? description : "",
      git: normalizeGitSettings(gitRaw),
      verify: normalizeVerify(verifyRaw),
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
      const entry: ManifestAppEntry = {
        name: a.name,
        path: a.rawPath,
      };
      if (a.description.trim().length > 0) {
        entry.description = a.description.trim();
      }
      const git = serializeGitSettings(a.git);
      if (git) entry.git = git;
      const verify = serializeVerify(a.verify);
      if (verify) entry.verify = verify;
      return entry;
    }),
  };
  return JSON.stringify(manifest, null, 2) + "\n";
}

export function loadApps(): App[] {
  if (!existsSync(BRIDGE_JSON)) return [];
  try {
    return parseApps(readFileSync(BRIDGE_JSON, "utf8"));
  } catch (err) {
    console.error("apps: cannot read", BRIDGE_JSON, err);
    return [];
  }
}

export function saveApps(apps: App[]): void {
  const manifest = readManifest();
  manifest.apps = apps.map((a) => {
    const entry: ManifestAppEntry = {
      name: a.name,
      path: a.rawPath,
    };
    if (a.description.trim().length > 0) entry.description = a.description.trim();
    const git = serializeGitSettings(a.git);
    if (git) entry.git = git;
    const verify = serializeVerify(a.verify);
    if (verify) entry.verify = verify;
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
    git: { ...DEFAULT_GIT_SETTINGS },
    verify: { ...DEFAULT_VERIFY },
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

/**
 * Patch a single app's description in place. Used by the
 * scan-with-claude flow to upgrade an auto-detected heuristic
 * description with a model-grounded summary. Returns the updated
 * App, or `null` if the name is unknown / invalid.
 */
export function updateAppDescription(name: string, description: string): App | null {
  if (!isValidAppName(name)) return null;
  const apps = loadApps();
  const target = apps.find((a) => a.name === name);
  if (!target) return null;
  target.description = (description ?? "").trim();
  saveApps(apps);
  return target;
}

/**
 * Patch a single app's git workflow settings. The caller passes a
 * partial — fields omitted retain their current value. `autoPush`
 * forces `autoCommit` to true (you can't push what you didn't commit).
 */
export function updateAppGitSettings(
  name: string,
  patch: Partial<AppGitSettings>,
): App | null {
  if (!isValidAppName(name)) return null;
  const apps = loadApps();
  const target = apps.find((a) => a.name === name);
  if (!target) return null;
  const next: AppGitSettings = { ...target.git, ...patch };
  if (next.branchMode !== "fixed") next.fixedBranch = "";
  else next.fixedBranch = (next.fixedBranch ?? "").trim();
  if (next.autoPush) next.autoCommit = true;
  target.git = next;
  saveApps(apps);
  return target;
}

/**
 * Patch a single app's verify contract. The caller passes a partial —
 * fields omitted retain their current value; passing an empty string
 * for a key clears that command. Empty trimmed values are dropped on
 * the way in (mirrors `normalizeVerify`), so callers can use `""` as
 * "unset this field".
 */
export function updateAppVerify(
  name: string,
  patch: Partial<AppVerify>,
): App | null {
  if (!isValidAppName(name)) return null;
  const apps = loadApps();
  const target = apps.find((a) => a.name === name);
  if (!target) return null;
  const next: AppVerify = { ...target.verify };
  for (const key of ["test", "lint", "build", "typecheck", "format"] as const) {
    if (!Object.prototype.hasOwnProperty.call(patch, key)) continue;
    const v = patch[key];
    if (typeof v === "string" && v.trim().length > 0) next[key] = v.trim();
    else delete next[key];
  }
  target.verify = next;
  saveApps(apps);
  return target;
}

export type RenameAppFailure =
  | "invalid-name"
  | "invalid-new-name"
  | "not-found"
  | "duplicate-name";

/**
 * Rename an app entry in `bridge.json`. Returns the updated `App` on
 * success or a string reason on failure. Side-effect: only the manifest
 * is touched here. Past tasks that reference the old name are migrated
 * separately by the API route via `tasksStore.migrateTaskApp`.
 *
 * No-op if `oldName === newName`.
 */
export function renameApp(
  oldName: string,
  newName: string,
): { ok: true; app: App } | { ok: false; reason: RenameAppFailure } {
  if (!isValidAppName(oldName)) return { ok: false, reason: "invalid-name" };
  if (!isValidAppName(newName)) return { ok: false, reason: "invalid-new-name" };
  const apps = loadApps();
  const target = apps.find((a) => a.name === oldName);
  if (!target) return { ok: false, reason: "not-found" };
  if (oldName === newName) return { ok: true, app: target };
  if (apps.some((a) => a.name === newName)) {
    return { ok: false, reason: "duplicate-name" };
  }
  target.name = newName;
  apps.sort((a, b) => a.name.localeCompare(b.name));
  saveApps(apps);
  return { ok: true, app: target };
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
      git: { ...DEFAULT_GIT_SETTINGS },
      verify: { ...DEFAULT_VERIFY },
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
