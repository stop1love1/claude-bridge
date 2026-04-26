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

/** (P4/F1) Worktree isolation policy for spawned children. */
export type GitWorktreeMode = "disabled" | "enabled";

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
  /**
   * (P4/F1) `enabled` runs every spawned child in a private
   * `.worktrees/<sessionId>` git worktree under the app's root. After
   * the post-exit gates pass, the bridge merges the worktree branch
   * back into the parent branch and removes the worktree. `disabled`
   * preserves historical behavior (children edit the live tree).
   * Defaults to `disabled` so existing apps don't change behavior.
   */
  worktreeMode: GitWorktreeMode;
}

export const DEFAULT_GIT_SETTINGS: AppGitSettings = {
  branchMode: "current",
  fixedBranch: "",
  autoCommit: false,
  autoPush: false,
  worktreeMode: "disabled",
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

/**
 * (P2b-2) Per-app quality gates — opt-in agent-driven post-exit checks
 * that run AFTER the inline claim-vs-diff verifier passes. Each is its
 * own LLM spawn (~30-100K tokens), so both default OFF.
 *
 *   critic   — style critic, rejects diffs that look "alien" against the
 *              codebase fingerprint + symbol index + house-rules.
 *              Suffix `-stretry` for the retry it triggers.
 *   verifier — semantic verifier, judges whether the claimed changes
 *              actually accomplish the task body. Suffix `-svretry`.
 *
 * Empty/missing object = both off → behavior identical to pre-P2b-2.
 */
export interface AppQuality {
  critic?: boolean;
  verifier?: boolean;
}

export const DEFAULT_QUALITY: AppQuality = {};

export interface App {
  name: string;
  path: string;          // absolute, resolved against BRIDGE_ROOT
  rawPath: string;       // exactly what the user wrote (relative or absolute)
  description: string;
  git: AppGitSettings;
  verify: AppVerify;
  /**
   * (P3a/B3) Files inside the app that are ALWAYS injected into every
   * spawned child's prompt. Use for canonical examples, type files,
   * routing manifests — anything an agent should see without burning
   * a Read tool call to discover. Paths are relative to the app root,
   * forward-slash separated. Empty / missing = feature off.
   */
  pinnedFiles: string[];
  /**
   * (P3a/A2) Override the default `[lib, utils, hooks, components/ui]`
   * symbol-index scan roots. Empty / missing = use the defaults.
   */
  symbolDirs: string[];
  /**
   * (P2b-2) Opt-in agent-driven quality gates. Defaults to all-off so
   * existing apps don't suddenly pay 2× LLM spawns per task. See
   * `AppQuality` docs for the per-flag semantics.
   */
  quality: AppQuality;
  /**
   * (Detect) Free-form domain capability tags this app owns. Used by
   * `lib/detect` to score this app against task bodies that mention
   * the same concepts. Examples:
   *   ["lms.course", "lms.lesson", "lms.student"]
   *   ["auth.login", "auth.signup", "billing.subscription"]
   *
   * Operator-curated; auto-derived from `RepoProfile.features` on
   * first add but freely editable. Empty / missing = the detector
   * falls back to its built-in feature vocab + repo profile signals.
   */
  capabilities: string[];
}

interface ManifestAppEntry {
  name: string;
  path: string;
  description?: string;
  git?: Partial<AppGitSettings>;
  verify?: AppVerify;
  pinnedFiles?: string[];
  symbolDirs?: string[];
  quality?: AppQuality;
  capabilities?: string[];
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
  const worktreeMode: GitWorktreeMode =
    r.worktreeMode === "enabled" ? "enabled" : "disabled";
  return { branchMode, fixedBranch, autoCommit, autoPush, worktreeMode };
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
 * Coerce arbitrary input into a string[]. Drops non-strings, blank
 * entries, and de-dupes. Used for `pinnedFiles` and `symbolDirs` —
 * both are lists of repo-relative path strings. We do NOT validate
 * for path traversal here; callers (`pinnedFiles.ts`, `symbolIndex.ts`)
 * resolve under the app root and any escape attempt simply lands on a
 * non-existent path, which they handle as "skip silently".
 */
function normalizeStringList(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const v of raw) {
    if (typeof v !== "string") continue;
    const trimmed = v.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

/**
 * Coerce arbitrary input into an `AppQuality`. Each flag must be the
 * literal `true`; anything else (false, missing, non-bool) treats the
 * gate as off. Returns `{}` when nothing is enabled.
 */
function normalizeQuality(raw: unknown): AppQuality {
  if (!raw || typeof raw !== "object") return { ...DEFAULT_QUALITY };
  const r = raw as Partial<Record<keyof AppQuality, unknown>>;
  const out: AppQuality = {};
  if (r.critic === true) out.critic = true;
  if (r.verifier === true) out.verifier = true;
  return out;
}

/**
 * Drop the `quality` key entirely when no gates are enabled — same
 * terse-default convention as `serializeVerify`.
 */
function serializeQuality(q: AppQuality | undefined): AppQuality | undefined {
  if (!q) return undefined;
  const out: AppQuality = {};
  if (q.critic === true) out.critic = true;
  if (q.verifier === true) out.verifier = true;
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Mirror of `serializeGitSettings` / `serializeVerify`: drop the key
 * entirely when the list is empty so `bridge.json` stays terse.
 */
function serializeStringList(arr: string[] | undefined): string[] | undefined {
  if (!arr || arr.length === 0) return undefined;
  const trimmed = arr.map((s) => s.trim()).filter((s) => s.length > 0);
  return trimmed.length > 0 ? trimmed : undefined;
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
  if (g.worktreeMode === "enabled") out.worktreeMode = "enabled";
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
    const pinnedRaw = (raw as { pinnedFiles?: unknown }).pinnedFiles;
    const symbolDirsRaw = (raw as { symbolDirs?: unknown }).symbolDirs;
    const qualityRaw = (raw as { quality?: unknown }).quality;
    const capabilitiesRaw = (raw as { capabilities?: unknown }).capabilities;
    if (!isValidAppName(name)) continue;
    if (typeof rawPath !== "string" || !rawPath.trim()) continue;
    out.push({
      name,
      rawPath,
      path: resolveAppPath(rawPath),
      description: typeof description === "string" ? description : "",
      git: normalizeGitSettings(gitRaw),
      verify: normalizeVerify(verifyRaw),
      pinnedFiles: normalizeStringList(pinnedRaw),
      symbolDirs: normalizeStringList(symbolDirsRaw),
      quality: normalizeQuality(qualityRaw),
      capabilities: normalizeStringList(capabilitiesRaw),
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
      const pinned = serializeStringList(a.pinnedFiles);
      if (pinned) entry.pinnedFiles = pinned;
      const symbolDirs = serializeStringList(a.symbolDirs);
      if (symbolDirs) entry.symbolDirs = symbolDirs;
      const quality = serializeQuality(a.quality);
      if (quality) entry.quality = quality;
      const capabilities = serializeStringList(a.capabilities);
      if (capabilities) entry.capabilities = capabilities;
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
    const pinned = serializeStringList(a.pinnedFiles);
    if (pinned) entry.pinnedFiles = pinned;
    const symbolDirs = serializeStringList(a.symbolDirs);
    if (symbolDirs) entry.symbolDirs = symbolDirs;
    const quality = serializeQuality(a.quality);
    if (quality) entry.quality = quality;
    const capabilities = serializeStringList(a.capabilities);
    if (capabilities) entry.capabilities = capabilities;
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
    pinnedFiles: [],
    symbolDirs: [],
    quality: { ...DEFAULT_QUALITY },
    capabilities: [],
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
  if (next.worktreeMode !== "enabled") next.worktreeMode = "disabled";
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

/**
 * Replace a single app's `capabilities` list. Used by the apps UI to
 * curate the domain tags `lib/detect` matches against. Empty input
 * clears the list (drops the field from `bridge.json` entirely).
 */
export function updateAppCapabilities(
  name: string,
  capabilities: string[],
): App | null {
  if (!isValidAppName(name)) return null;
  const apps = loadApps();
  const target = apps.find((a) => a.name === name);
  if (!target) return null;
  target.capabilities = normalizeStringList(capabilities);
  saveApps(apps);
  return target;
}

/**
 * Read the bridge-wide detect source from `bridge.json`. Lives at
 * the manifest top level so it isn't tied to any single app — every
 * task creation reads it once. Defaults to `auto` when missing.
 */
export type DetectManifestSource = "auto" | "llm" | "heuristic";

export function getManifestDetectSource(): DetectManifestSource {
  const m = readManifest();
  const det = (m as { detect?: { source?: unknown } }).detect;
  const s = det?.source;
  if (s === "llm" || s === "heuristic" || s === "auto") return s;
  return "auto";
}

/**
 * Persist the bridge-wide detect source. Read-modify-write the whole
 * manifest so other top-level keys (settings, experiments, …) stay
 * intact.
 */
export function setManifestDetectSource(source: DetectManifestSource): void {
  const manifest = readManifest();
  const next = {
    ...manifest,
    detect: { source },
  };
  writeManifest(next);
}

/**
 * Telegram notifier credentials, persisted at the bridge.json top level
 * so the operator manages them through the bridge UI rather than a
 * shell-scoped `.env`. Both fields are required for the notifier to
 * actually send — empty strings disable it (matches the previous env
 * behavior).
 */
export interface TelegramSettings {
  botToken: string;
  chatId: string;
}

export const DEFAULT_TELEGRAM_SETTINGS: TelegramSettings = {
  botToken: "",
  chatId: "",
};

export function getManifestTelegramSettings(): TelegramSettings {
  const m = readManifest();
  const tg = (m as { telegram?: { botToken?: unknown; chatId?: unknown } })
    .telegram;
  if (!tg || typeof tg !== "object") {
    // Fallback to env for the legacy install path so an existing
    // operator's `.env` keeps working until they migrate to bridge.json.
    return {
      botToken: (process.env.TELEGRAM_BOT_TOKEN ?? "").trim(),
      chatId: (process.env.TELEGRAM_CHAT_ID ?? "").trim(),
    };
  }
  const botToken = typeof tg.botToken === "string" ? tg.botToken.trim() : "";
  const chatId = typeof tg.chatId === "string" ? tg.chatId.trim() : "";
  // bridge.json takes precedence, but if EITHER field is empty we still
  // fall through to env so partial bridge.json + complete .env keeps
  // working (the env vars used to be the canonical source).
  if (!botToken || !chatId) {
    const envToken = (process.env.TELEGRAM_BOT_TOKEN ?? "").trim();
    const envChat = (process.env.TELEGRAM_CHAT_ID ?? "").trim();
    return {
      botToken: botToken || envToken,
      chatId: chatId || envChat,
    };
  }
  return { botToken, chatId };
}

export function setManifestTelegramSettings(
  patch: Partial<TelegramSettings>,
): TelegramSettings {
  const manifest = readManifest();
  const current = (manifest as { telegram?: TelegramSettings }).telegram ?? {
    ...DEFAULT_TELEGRAM_SETTINGS,
  };
  const next: TelegramSettings = {
    botToken:
      typeof patch.botToken === "string"
        ? patch.botToken.trim()
        : current.botToken,
    chatId:
      typeof patch.chatId === "string" ? patch.chatId.trim() : current.chatId,
  };
  // Drop the section entirely when both fields are empty so bridge.json
  // doesn't carry a meaningless `telegram: { botToken: "", chatId: "" }`.
  const updatedManifest: BridgeManifest = { ...manifest };
  if (next.botToken === "" && next.chatId === "") {
    delete (updatedManifest as { telegram?: TelegramSettings }).telegram;
  } else {
    (updatedManifest as { telegram?: TelegramSettings }).telegram = next;
  }
  writeManifest(updatedManifest);
  return next;
}

/**
 * Patch a single app's quality gates. Caller passes a partial — fields
 * omitted retain their current value. Setting a flag to anything other
 * than the literal `true` clears it (matches `normalizeQuality`).
 */
export function updateAppQuality(
  name: string,
  patch: Partial<AppQuality>,
): App | null {
  if (!isValidAppName(name)) return null;
  const apps = loadApps();
  const target = apps.find((a) => a.name === name);
  if (!target) return null;
  const next: AppQuality = { ...target.quality };
  for (const key of ["critic", "verifier"] as const) {
    if (!Object.prototype.hasOwnProperty.call(patch, key)) continue;
    if (patch[key] === true) next[key] = true;
    else delete next[key];
  }
  target.quality = next;
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
      pinnedFiles: [],
      symbolDirs: [],
      quality: { ...DEFAULT_QUALITY },
      capabilities: [],
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
