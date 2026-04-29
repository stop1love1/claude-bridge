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

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { BRIDGE_ROOT } from "./paths";
import {
  BRIDGE_JSON,
  onBridgeManifestWrite,
  readBridgeManifest,
  writeBridgeManifest,
} from "./bridgeManifest";

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

/**
 * Post-success integration mode — what the bridge does with the agent's
 * work branch after auto-commit succeeds.
 *
 *   - `none`         — leave the branch alone (historical default)
 *   - `auto-merge`   — `git checkout <target> && git merge --no-ff` locally
 *   - `pull-request` — spawn a `devops` LLM child that uses `gh` (GitHub)
 *                      or `glab` (GitLab) to open a PR/MR against `target`.
 *                      Requires git remote + the matching CLI installed;
 *                      falls back to no-op + warning if either is missing.
 *
 * Both non-`none` modes require `mergeTargetBranch`. `pull-request` also
 * implies `autoPush` (the head branch must reach the remote first).
 */
export type GitIntegrationMode = "none" | "auto-merge" | "pull-request";

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
  /**
   * Integration target branch — used when `integrationMode` is
   * `auto-merge` (local merge) or `pull-request` (devops agent opens
   * a PR/MR). Empty string is required when `integrationMode === "none"`.
   *
   * Use case: `branchMode: "auto-create"` produces `claude/<task-id>`,
   * and the operator wants the bridge to roll that branch up into
   * `main` (or `develop`) automatically rather than mopping up by hand.
   */
  mergeTargetBranch: string;
  /**
   * What the bridge does with the agent's work branch after auto-commit:
   *
   *   - `none`         — leave it (default)
   *   - `auto-merge`   — local `git merge --no-ff` into `mergeTargetBranch`.
   *                      Conflict aborts cleanly; work branch preserved.
   *   - `pull-request` — spawn a `devops` LLM child that runs `gh` /
   *                      `glab` to open a PR/MR. Requires git remote +
   *                      the matching CLI installed locally; otherwise
   *                      logs a warning and skips.
   *
   * Implies `autoCommit` for both non-`none` modes. `pull-request` also
   * implies `autoPush` so the head branch is on the remote before the
   * CLI tries to open the PR/MR.
   */
  integrationMode: GitIntegrationMode;
}

export const DEFAULT_GIT_SETTINGS: AppGitSettings = {
  branchMode: "current",
  fixedBranch: "",
  autoCommit: false,
  autoPush: false,
  worktreeMode: "disabled",
  mergeTargetBranch: "",
  integrationMode: "none",
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

/**
 * (Gap 2) Per-gate retry budgets. Each gate has an independent counter;
 * 0 disables retries for that gate, ≥1 = max attempts. Capped by
 * `MAX_RETRY_PER_GATE` from `retryLadder.ts` regardless of value here.
 *
 * Defaults (when missing) preserve historical 1-shot behavior. See
 * `libs/retryLadder.ts` for the ladder logic and the strategy registry.
 *
 *   crash     — child crash retry (libs/childRetry.ts)
 *   verify    — verify-chain failure retry (libs/verifyChain.ts)
 *   claim     — claim-vs-diff retry (libs/verifier.ts)
 *   preflight — preflight (read-before-edit) retry (libs/preflightCheck.ts)
 *   style     — style critic retry (libs/styleCritic.ts)
 *   semantic  — semantic verifier retry (libs/semanticVerifier.ts)
 */
export interface AppRetry {
  crash?: number;
  verify?: number;
  claim?: number;
  preflight?: number;
  style?: number;
  semantic?: number;
}

export const DEFAULT_APP_RETRY: AppRetry = {};

/**
 * Per-app auto-memory settings. After a task succeeds (no retry
 * scheduled, all gates passed), the bridge can spawn a small distill
 * agent that reads the run's report + diff + verdict and proposes
 * 1-3 durable rules for `<appPath>/.bridge/memory.md`. Subsequent
 * spawns inject those rules via the existing `## Memory` section.
 *
 *   distill — opt-in (default off). When true, post-success runs
 *             on this app trigger an automatic `memory-distill`
 *             agent. Failed gates / retries skip distillation.
 *
 * Empty/missing object = off → behavior identical to pre-feature.
 */
export interface AppMemory {
  distill?: boolean;
}

export const DEFAULT_APP_MEMORY: AppMemory = {};

/**
 * Per-app speculative dispatch settings. When enabled, the bridge fans
 * out N parallel children for the same role (e.g. coder) on each
 * dispatch. The first run that passes the post-exit gates wins; siblings
 * are killed and their worktrees cleaned up. Trades token cost for
 * lower wall-time on tasks where multiple plausible approaches exist.
 *
 *   enabled — feature switch (default false).
 *   n       — fan-out count, clamped to [2, 4]. Defaults to 2 when
 *             enabled and unspecified.
 *   roles   — which roles trigger fan-out. Defaults to ["coder"].
 *             Coordinator / reviewer / planner roles are typically
 *             unsuitable (they orchestrate / read; one truth wins).
 *
 * Empty/missing object or `enabled:false` = behavior identical to
 * pre-feature (one child per dispatch).
 */
export interface AppDispatch {
  speculative?: {
    enabled?: boolean;
    n?: number;
    roles?: string[];
  };
}

export const DEFAULT_APP_DISPATCH: AppDispatch = {};

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
   * (Gap 2) Per-gate retry budgets. Empty / missing = each gate uses
   * `DEFAULT_RETRY` (1 attempt) per `retryLadder.ts`. Operators bump
   * a specific gate higher to allow multi-strategy retry ladders.
   */
  retry: AppRetry;
  /**
   * Auto-memory settings — when `distill: true`, the post-exit flow
   * spawns a memory-distill agent on success runs. See `AppMemory`.
   */
  memory: AppMemory;
  /**
   * Speculative dispatch — when `speculative.enabled`, the agents
   * route fans out N parallel children for matching roles. See
   * `AppDispatch`.
   */
  dispatch: AppDispatch;
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
  retry?: AppRetry;
  memory?: AppMemory;
  dispatch?: AppDispatch;
}

export interface BridgeManifest {
  version: number;
  apps: ManifestAppEntry[];
  [key: string]: unknown;
}

const APP_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const SCHEMA_VERSION = 1;

export function isValidAppName(name: unknown): name is string {
  return typeof name === "string" && APP_NAME_RE.test(name);
}

function resolveAppPath(rawPath: string): string {
  if (!rawPath) return rawPath;
  return isAbsolute(rawPath) ? resolve(rawPath) : resolve(BRIDGE_ROOT, rawPath);
}

/**
 * Read the apps-flavored view of `bridge.json`. Goes through the shared
 * `bridgeManifest` cache, so reads colocate with auth/tunnels reads
 * (single fs hit per ~1s) and writes from any module invalidate this
 * derived cache too (see `onBridgeManifestWrite` below).
 */
function readManifest(): BridgeManifest {
  const raw = readBridgeManifest();
  return {
    version: typeof raw.version === "number" ? raw.version : SCHEMA_VERSION,
    apps: Array.isArray(raw.apps) ? (raw.apps as ManifestAppEntry[]) : [],
    ...Object.fromEntries(
      Object.entries(raw).filter(([k]) => k !== "version" && k !== "apps"),
    ),
  };
}

function writeManifest(manifest: BridgeManifest): void {
  writeBridgeManifest({
    ...(manifest as unknown as Record<string, unknown>),
    version: SCHEMA_VERSION,
    apps: manifest.apps,
  });
  // appsCache invalidation is handled by the onBridgeManifestWrite
  // subscriber registered alongside `let appsCache` below — that
  // subscriber fires for writes from auth.ts and tunnels.ts as well,
  // so a tunnel authtoken save can't strand a stale apps cache.
}

function normalizeGitSettings(raw: unknown): AppGitSettings {
  if (!raw || typeof raw !== "object") return { ...DEFAULT_GIT_SETTINGS };
  const r = raw as Partial<AppGitSettings>;
  const branchMode: GitBranchMode =
    r.branchMode === "fixed" || r.branchMode === "auto-create" ? r.branchMode : "current";
  const fixedBranch = typeof r.fixedBranch === "string" ? r.fixedBranch.trim() : "";
  const mergeTargetBranch =
    typeof r.mergeTargetBranch === "string" ? r.mergeTargetBranch.trim() : "";
  // Backwards compat: an old manifest may have only `mergeTargetBranch`
  // set (from the first auto-merge ship). Treat that as `auto-merge`
  // so existing operators don't lose behavior on upgrade.
  let integrationMode: GitIntegrationMode =
    r.integrationMode === "auto-merge" || r.integrationMode === "pull-request"
      ? r.integrationMode
      : "none";
  if (integrationMode === "none" && mergeTargetBranch.length > 0 && r.integrationMode === undefined) {
    integrationMode = "auto-merge";
  }
  // Empty mergeTargetBranch with a non-none mode is a malformed config —
  // demote to `none` so we never run integration on a missing target.
  if (integrationMode !== "none" && mergeTargetBranch.length === 0) {
    integrationMode = "none";
  }
  // Integration requires a commit (auto-merge) or commit+push (PR).
  const autoCommit =
    r.autoCommit === true || r.autoPush === true || integrationMode !== "none";
  const autoPush = r.autoPush === true || integrationMode === "pull-request";
  const worktreeMode: GitWorktreeMode =
    r.worktreeMode === "enabled" ? "enabled" : "disabled";
  return {
    branchMode,
    fixedBranch,
    autoCommit,
    autoPush,
    worktreeMode,
    mergeTargetBranch,
    integrationMode,
  };
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
 * (Gap 2) Coerce arbitrary input into an `AppRetry`. Each field must be
 * a finite non-negative integer; out-of-range values are dropped (the
 * ladder falls back to `DEFAULT_RETRY` for missing keys, and clamps
 * upper bounds via `MAX_RETRY_PER_GATE` at read time, so invalid input
 * here just degrades to the default).
 */
function normalizeRetry(raw: unknown): AppRetry {
  if (!raw || typeof raw !== "object") return { ...DEFAULT_APP_RETRY };
  const r = raw as Partial<Record<keyof AppRetry, unknown>>;
  const out: AppRetry = {};
  for (const key of [
    "crash", "verify", "claim", "preflight", "style", "semantic",
  ] as const) {
    const v = r[key];
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0) continue;
    out[key] = Math.floor(v);
  }
  return out;
}

/**
 * Drop the `retry` key entirely when no overrides are set — same terse-
 * default convention as `serializeQuality`.
 */
function serializeRetry(r: AppRetry | undefined): AppRetry | undefined {
  if (!r) return undefined;
  const out: AppRetry = {};
  for (const key of [
    "crash", "verify", "claim", "preflight", "style", "semantic",
  ] as const) {
    const v = r[key];
    if (typeof v === "number" && Number.isFinite(v) && v >= 0) {
      out[key] = Math.floor(v);
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
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

function normalizeMemory(raw: unknown): AppMemory {
  if (!raw || typeof raw !== "object") return { ...DEFAULT_APP_MEMORY };
  const r = raw as Partial<Record<keyof AppMemory, unknown>>;
  const out: AppMemory = {};
  if (r.distill === true) out.distill = true;
  return out;
}

function serializeMemory(m: AppMemory | undefined): AppMemory | undefined {
  if (!m) return undefined;
  const out: AppMemory = {};
  if (m.distill === true) out.distill = true;
  return Object.keys(out).length > 0 ? out : undefined;
}

const SPECULATIVE_MIN_N = 2;
const SPECULATIVE_MAX_N = 4;
const SPECULATIVE_DEFAULT_N = 2;
const SPECULATIVE_DEFAULT_ROLES: readonly string[] = ["coder"];

function normalizeDispatch(raw: unknown): AppDispatch {
  if (!raw || typeof raw !== "object") return { ...DEFAULT_APP_DISPATCH };
  const r = raw as { speculative?: unknown };
  const sRaw = r.speculative;
  if (!sRaw || typeof sRaw !== "object") return {};
  const s = sRaw as { enabled?: unknown; n?: unknown; roles?: unknown };
  const enabled = s.enabled === true;
  if (!enabled) return {};
  let n = SPECULATIVE_DEFAULT_N;
  if (typeof s.n === "number" && Number.isFinite(s.n)) {
    n = Math.max(SPECULATIVE_MIN_N, Math.min(SPECULATIVE_MAX_N, Math.floor(s.n)));
  }
  const rolesRaw = s.roles;
  let roles: string[];
  if (Array.isArray(rolesRaw)) {
    roles = rolesRaw
      .filter((x): x is string => typeof x === "string" && x.trim().length > 0)
      .map((x) => x.trim());
    if (roles.length === 0) roles = [...SPECULATIVE_DEFAULT_ROLES];
  } else {
    roles = [...SPECULATIVE_DEFAULT_ROLES];
  }
  return { speculative: { enabled: true, n, roles } };
}

function serializeDispatch(d: AppDispatch | undefined): AppDispatch | undefined {
  if (!d || !d.speculative || !d.speculative.enabled) return undefined;
  return {
    speculative: {
      enabled: true,
      n: d.speculative.n ?? SPECULATIVE_DEFAULT_N,
      roles: d.speculative.roles ?? [...SPECULATIVE_DEFAULT_ROLES],
    },
  };
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
  if (g.mergeTargetBranch && g.mergeTargetBranch.trim().length > 0) {
    out.mergeTargetBranch = g.mergeTargetBranch.trim();
  }
  if (g.integrationMode && g.integrationMode !== "none") {
    out.integrationMode = g.integrationMode;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Public for tests — parse a manifest blob without touching disk. */
export function parseApps(json: string): App[] {
  if (!json || !json.trim()) return [];
  let parsed: Partial<BridgeManifest>;
  try { parsed = JSON.parse(json) as Partial<BridgeManifest>; }
  catch { return []; }
  return parseAppsFromManifest(parsed);
}

/**
 * Same as `parseApps` but takes an already-parsed manifest object.
 * Used by `loadApps` so the shared bridgeManifest cache can hand us
 * the parsed object directly — no need for a string→JSON.parse round
 * trip per cache miss.
 */
function parseAppsFromManifest(parsed: Partial<BridgeManifest> | Record<string, unknown>): App[] {
  if (!Array.isArray((parsed as Partial<BridgeManifest>).apps)) return [];
  const apps = (parsed as Partial<BridgeManifest>).apps as ManifestAppEntry[];
  const out: App[] = [];
  for (const raw of apps) {
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
    const retryRaw = (raw as { retry?: unknown }).retry;
    const memoryRaw = (raw as { memory?: unknown }).memory;
    const dispatchRaw = (raw as { dispatch?: unknown }).dispatch;
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
      retry: normalizeRetry(retryRaw),
      memory: normalizeMemory(memoryRaw),
      dispatch: normalizeDispatch(dispatchRaw),
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
      const retry = serializeRetry(a.retry);
      if (retry) entry.retry = retry;
      const memory = serializeMemory(a.memory);
      if (memory) entry.memory = memory;
      const dispatch = serializeDispatch(a.dispatch);
      if (dispatch) entry.dispatch = dispatch;
      return entry;
    }),
  };
  return JSON.stringify(manifest, null, 2) + "\n";
}

// Short-lived in-process cache for parsed apps. The post-exit flow
// hits getApp() 6+ times in sequence — without this, each call re-reads
// + JSON.parses bridge.json synchronously, which is the bulk of the
// per-spawn overhead. Invalidated explicitly by saveApps() so a UI
// edit takes effect immediately.
const APPS_CACHE_TTL_MS = 1000;
let appsCache: { value: App[]; expires: number } | null = null;
// Drop the derived apps cache whenever ANY module rewrites bridge.json
// (apps.ts itself, auth.ts saving credentials, tunnels.ts saving the
// ngrok authtoken). Without this an authtoken save inside the 1s TTL
// would let the next `loadApps()` serve a cache built from the
// pre-write snapshot, so a parallel git-settings change races into a
// stale view.
onBridgeManifestWrite(() => { appsCache = null; });

export function loadApps(): App[] {
  const now = Date.now();
  if (appsCache && appsCache.expires > now) return appsCache.value;
  let value: App[];
  if (!existsSync(BRIDGE_JSON)) {
    value = [];
  } else {
    try {
      value = parseAppsFromManifest(readBridgeManifest());
    } catch (err) {
      console.error("apps: cannot read", BRIDGE_JSON, err);
      value = [];
    }
  }
  appsCache = { value, expires: now + APPS_CACHE_TTL_MS };
  return value;
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
    const retry = serializeRetry(a.retry);
    if (retry) entry.retry = retry;
    const memory = serializeMemory(a.memory);
    if (memory) entry.memory = memory;
    const dispatch = serializeDispatch(a.dispatch);
    if (dispatch) entry.dispatch = dispatch;
    return entry;
  });
  writeManifest(manifest);
  appsCache = null;
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
    retry: { ...DEFAULT_APP_RETRY },
    memory: { ...DEFAULT_APP_MEMORY },
    dispatch: { ...DEFAULT_APP_DISPATCH },
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
  if (next.worktreeMode !== "enabled") next.worktreeMode = "disabled";
  next.mergeTargetBranch = (next.mergeTargetBranch ?? "").trim();
  if (next.integrationMode !== "auto-merge" && next.integrationMode !== "pull-request") {
    next.integrationMode = "none";
  }
  // Empty target with a non-none mode is malformed — demote so we don't
  // run integration on a missing target.
  if (next.integrationMode !== "none" && next.mergeTargetBranch.length === 0) {
    next.integrationMode = "none";
  }
  if (next.integrationMode !== "none") next.autoCommit = true;
  if (next.integrationMode === "pull-request") next.autoPush = true;
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
 * Operator-configured public origin for the bridge — the URL it's
 * reachable at after a deploy / behind a reverse proxy. Persisted at
 * `bridge.json#publicUrl` and surfaced everywhere the bridge needs to
 * render an absolute link the operator (or someone they share with) can
 * actually click: Telegram task notifications, login-approval emails,
 * any future webhook payloads.
 *
 * Stored without a trailing slash so consumers can naively concatenate
 * `${publicUrl}/tasks/${id}` without producing `//`.
 *
 * Validation rules:
 *   - Empty string is allowed and means "no public URL configured"
 *     (callers fall back to `runtime.url` / localhost).
 *   - Must parse via `new URL(...)` and use http:/https: protocol —
 *     anything else (file:, javascript:, ftp:) is rejected.
 *   - Pathname / search / hash are stripped: only the origin survives.
 */
function normalizePublicUrl(raw: unknown): string {
  if (typeof raw !== "string") return "";
  const trimmed = raw.trim();
  if (!trimmed) return "";
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return "";
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "";
  // Origin only; drop trailing slash + any path/query/hash an operator
  // pasted by accident from a deeper page they were on.
  return parsed.origin;
}

export function getManifestPublicUrl(): string {
  const m = readManifest();
  return normalizePublicUrl((m as { publicUrl?: unknown }).publicUrl);
}

/**
 * Persist the operator-configured public URL. Pass `""` (empty string)
 * to clear it — the field is dropped from the manifest entirely so a
 * fresh `cat bridge.json` doesn't carry a meaningless `"publicUrl": ""`.
 *
 * Returns the post-write value (which may differ from the input if the
 * operator pasted a URL with a path or invalid protocol).
 */
export function setManifestPublicUrl(input: string): string {
  const normalized = normalizePublicUrl(input);
  // Empty input is a deliberate clear — we still want to handle that
  // path explicitly rather than silently no-op.
  const explicitClear = typeof input === "string" && input.trim() === "";
  const manifest = readManifest();
  const updated: BridgeManifest = { ...manifest };
  if (!normalized && !explicitClear && typeof input === "string") {
    // Caller passed a non-empty value that failed validation — leave
    // the existing value alone rather than silently nuking it. The API
    // route surfaces this as a 400 before it ever reaches us, but
    // belt-and-suspenders for direct programmatic callers.
    return getManifestPublicUrl();
  }
  if (normalized) {
    (updated as { publicUrl?: string }).publicUrl = normalized;
  } else {
    delete (updated as { publicUrl?: string }).publicUrl;
  }
  writeManifest(updated);
  return normalized;
}

/**
 * Telegram notifier credentials, persisted at the bridge.json top level
 * so the operator manages them through the bridge UI rather than a
 * shell-scoped `.env`. Both `botToken` + `chatId` are required for the
 * Bot API channel; the optional `user` block enables a parallel
 * MTProto user-account channel (gram-js) that posts as the operator's
 * own account. Either channel disabled by leaving its fields empty.
 *
 * `user.targetChatId` is where the user-client posts notifications
 * (typically the operator's own user id = "Saved Messages", or any
 * chat the user is a member of). Defaults to "me" (Saved Messages)
 * when set to empty string at runtime.
 */
export interface TelegramUserSettings {
  /** From my.telegram.org/apps — number. */
  apiId: number;
  /** From my.telegram.org/apps — 32-char hex string. */
  apiHash: string;
  /**
   * Persisted gram-js StringSession (~500 chars base64). Generated by
   * `bun scripts/telegram-login.ts`. Cleared by `Logout` in the UI.
   */
  session: string;
  /**
   * Where outbound notifications and command replies are posted.
   * Empty string → "me" (the operator's own Saved Messages chat).
   * Otherwise: numeric chat id ("123456789", "-1001234567890") or a
   * @username (gram-js will resolve it).
   */
  targetChatId: string;
}

export const DEFAULT_TELEGRAM_USER_SETTINGS: TelegramUserSettings = {
  apiId: 0,
  apiHash: "",
  session: "",
  targetChatId: "",
};

/**
 * Chat-forwarding policy. Controls whether assistant messages from
 * spawned Claude sessions are mirrored to Telegram in addition to the
 * default lifecycle / permission events.
 *
 *   "off"               — never forward chat (default; matches legacy behavior)
 *   "coordinator-only"  — forward messages from `role: "coordinator"`
 *                          sessions only. The most useful default — the
 *                          coordinator is the human-readable summary
 *                          surface; child runs are noisy.
 *   "all"               — forward every spawned run's assistant text.
 *                          Use for low-traffic deployments / debugging.
 */
export type TelegramForwardChat = "off" | "coordinator-only" | "all";

export const DEFAULT_FORWARD_CHAT: TelegramForwardChat = "off";
export const DEFAULT_FORWARD_CHAT_MIN_CHARS = 40;

/**
 * Notification volume preset. Drives `libs/telegramNotifier`'s gating of
 * lifecycle / section / permission events.
 *
 *   "minimal"  — only what the operator must act on:
 *                  · coordinator done/failed (the "READY FOR REVIEW" signal)
 *                  · ANY child failure
 *                  · section moves to BLOCKED / DONE
 *                  · permission requests, coalesced per session+tool
 *   "normal"   — minimal + child completions + "Started" section moves.
 *                The recommended default — actionable signal without spam.
 *   "verbose"  — legacy behavior: every transition, every section move,
 *                every permission request individually. Useful for
 *                debugging the bridge itself.
 */
export type TelegramNotificationLevel = "minimal" | "normal" | "verbose";

export const DEFAULT_NOTIFICATION_LEVEL: TelegramNotificationLevel = "normal";

/**
 * Chat-forwarder line filter. Independent of `forwardChat` (which picks
 * WHICH agents to follow): this picks WHICH messages from those agents
 * make it through.
 *
 *   "important-only" — only flush buffers whose text matches
 *                      `/NEEDS-DECISION|BLOCKED|READY FOR REVIEW/i`.
 *                      Matches the project's escalation convention so
 *                      coordinators can think out loud without paging
 *                      the operator. Default.
 *   "all"            — flush every buffer above the min-char threshold.
 *                      Equivalent to legacy behavior.
 */
export type TelegramForwardChatFilter = "important-only" | "all";

export const DEFAULT_FORWARD_CHAT_FILTER: TelegramForwardChatFilter =
  "important-only";

export interface TelegramSettings {
  botToken: string;
  chatId: string;
  user: TelegramUserSettings;
  /** See `TelegramForwardChat`. Default `"off"`. */
  forwardChat: TelegramForwardChat;
  /**
   * Minimum length (in characters, after trim) for an assistant message
   * to be forwarded. Filters trivial replies like "OK", "Done.", "Got
   * it." that would otherwise spam the chat. Default 40. Ignored when
   * `forwardChat === "off"`.
   */
  forwardChatMinChars: number;
  /** Lifecycle / permission notification volume. See type docstring. */
  notificationLevel: TelegramNotificationLevel;
  /** Which forwarded chat lines pass the filter. See type docstring. */
  forwardChatFilter: TelegramForwardChatFilter;
  /**
   * Token list that gates `forwardChatFilter === "important-only"`. A
   * forwarded message must contain ANY of these (case-insensitive
   * substring match) to pass the filter. Defaults to the coordinator
   * escalation tokens (`NEEDS-DECISION`, `BLOCKED`,
   * `READY FOR REVIEW`) — the strings `prompts/coordinator.md`
   * documents as "the coordinator MUST emit when it needs the
   * operator". Operators with custom prompts can swap these via
   * `~/.claude/bridge.json#telegram.forwardChatImportantPatterns`.
   */
  forwardChatImportantPatterns: string[];
}

/**
 * Default tokens for `forwardChatImportantPatterns`. The coordinator
 * is required by `prompts/coordinator.md` to use these literal strings
 * for escalation, so any deployment using the stock prompt should
 * leave the default in place.
 */
export const DEFAULT_FORWARD_CHAT_IMPORTANT_PATTERNS: ReadonlyArray<string> = [
  "NEEDS-DECISION",
  "BLOCKED",
  "READY FOR REVIEW",
];

export const DEFAULT_TELEGRAM_SETTINGS: TelegramSettings = {
  botToken: "",
  chatId: "",
  user: { ...DEFAULT_TELEGRAM_USER_SETTINGS },
  forwardChat: DEFAULT_FORWARD_CHAT,
  forwardChatMinChars: DEFAULT_FORWARD_CHAT_MIN_CHARS,
  notificationLevel: DEFAULT_NOTIFICATION_LEVEL,
  forwardChatFilter: DEFAULT_FORWARD_CHAT_FILTER,
  forwardChatImportantPatterns: [...DEFAULT_FORWARD_CHAT_IMPORTANT_PATTERNS],
};

/**
 * Coerce a manifest `telegram.user` blob into a normalized
 * `TelegramUserSettings`, dropping invalid fields silently. Used by
 * the getter below so callers always get a fully-shaped object even
 * when the on-disk JSON is partial.
 */
function normalizeTelegramUserSettings(raw: unknown): TelegramUserSettings {
  if (!raw || typeof raw !== "object") {
    return { ...DEFAULT_TELEGRAM_USER_SETTINGS };
  }
  const r = raw as Partial<TelegramUserSettings>;
  const apiId = typeof r.apiId === "number" && Number.isFinite(r.apiId) ? Math.floor(r.apiId) : 0;
  const apiHash = typeof r.apiHash === "string" ? r.apiHash.trim() : "";
  const session = typeof r.session === "string" ? r.session.trim() : "";
  const targetChatId = typeof r.targetChatId === "string" ? r.targetChatId.trim() : "";
  return { apiId, apiHash, session, targetChatId };
}

function normalizeForwardChat(raw: unknown): TelegramForwardChat {
  if (raw === "coordinator-only" || raw === "all" || raw === "off") return raw;
  return DEFAULT_FORWARD_CHAT;
}

function normalizeForwardChatMinChars(raw: unknown): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    return DEFAULT_FORWARD_CHAT_MIN_CHARS;
  }
  // Clamp to a sane range so a footgun value (negative, 100k) doesn't
  // either disable filtering entirely or mute every message.
  const v = Math.floor(raw);
  if (v < 0) return 0;
  if (v > 5000) return 5000;
  return v;
}

function normalizeNotificationLevel(raw: unknown): TelegramNotificationLevel {
  if (raw === "minimal" || raw === "normal" || raw === "verbose") return raw;
  return DEFAULT_NOTIFICATION_LEVEL;
}

function normalizeForwardChatFilter(raw: unknown): TelegramForwardChatFilter {
  if (raw === "important-only" || raw === "all") return raw;
  return DEFAULT_FORWARD_CHAT_FILTER;
}

/**
 * Coerce raw `forwardChatImportantPatterns` from disk into a clean
 * `string[]`. Drops empty entries, trims whitespace, dedupes, caps at
 * 32 patterns / 200 chars each so a footgun config can't blow up the
 * regex compile in `telegramChatForwarder`.
 *
 * Falls back to the default token list when the raw value is missing
 * or doesn't normalize to at least one pattern.
 */
function normalizeForwardChatImportantPatterns(raw: unknown): string[] {
  if (!Array.isArray(raw)) {
    return [...DEFAULT_FORWARD_CHAT_IMPORTANT_PATTERNS];
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string") continue;
    const trimmed = item.trim();
    if (!trimmed) continue;
    const capped = trimmed.length > 200 ? trimmed.slice(0, 200) : trimmed;
    const key = capped.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(capped);
    if (out.length >= 32) break;
  }
  return out.length > 0 ? out : [...DEFAULT_FORWARD_CHAT_IMPORTANT_PATTERNS];
}

export function getManifestTelegramSettings(): TelegramSettings {
  const m = readManifest();
  const tg = (m as {
    telegram?: {
      botToken?: unknown;
      chatId?: unknown;
      user?: unknown;
      forwardChat?: unknown;
      forwardChatMinChars?: unknown;
      notificationLevel?: unknown;
      forwardChatFilter?: unknown;
      forwardChatImportantPatterns?: unknown;
    };
  }).telegram;
  if (!tg || typeof tg !== "object") {
    // Fallback to env for the legacy install path so an existing
    // operator's `.env` keeps working until they migrate to bridge.json.
    return {
      botToken: (process.env.TELEGRAM_BOT_TOKEN ?? "").trim(),
      chatId: (process.env.TELEGRAM_CHAT_ID ?? "").trim(),
      user: { ...DEFAULT_TELEGRAM_USER_SETTINGS },
      forwardChat: DEFAULT_FORWARD_CHAT,
      forwardChatMinChars: DEFAULT_FORWARD_CHAT_MIN_CHARS,
      notificationLevel: DEFAULT_NOTIFICATION_LEVEL,
      forwardChatFilter: DEFAULT_FORWARD_CHAT_FILTER,
      forwardChatImportantPatterns: [...DEFAULT_FORWARD_CHAT_IMPORTANT_PATTERNS],
    };
  }
  const botToken = typeof tg.botToken === "string" ? tg.botToken.trim() : "";
  const chatId = typeof tg.chatId === "string" ? tg.chatId.trim() : "";
  const user = normalizeTelegramUserSettings(tg.user);
  const forwardChat = normalizeForwardChat(tg.forwardChat);
  const forwardChatMinChars = normalizeForwardChatMinChars(tg.forwardChatMinChars);
  const notificationLevel = normalizeNotificationLevel(tg.notificationLevel);
  const forwardChatFilter = normalizeForwardChatFilter(tg.forwardChatFilter);
  const forwardChatImportantPatterns = normalizeForwardChatImportantPatterns(
    tg.forwardChatImportantPatterns,
  );
  // bridge.json takes precedence, but if EITHER bot field is empty we
  // still fall through to env for those (the user-client side has no
  // env fallback — it's strictly bridge.json).
  if (!botToken || !chatId) {
    const envToken = (process.env.TELEGRAM_BOT_TOKEN ?? "").trim();
    const envChat = (process.env.TELEGRAM_CHAT_ID ?? "").trim();
    return {
      botToken: botToken || envToken,
      chatId: chatId || envChat,
      user,
      forwardChat,
      forwardChatMinChars,
      notificationLevel,
      forwardChatFilter,
      forwardChatImportantPatterns,
    };
  }
  return {
    botToken,
    chatId,
    user,
    forwardChat,
    forwardChatMinChars,
    notificationLevel,
    forwardChatFilter,
    forwardChatImportantPatterns,
  };
}

export function setManifestTelegramSettings(
  patch: {
    botToken?: string;
    chatId?: string;
    user?: Partial<TelegramUserSettings>;
    forwardChat?: TelegramForwardChat;
    forwardChatMinChars?: number;
    notificationLevel?: TelegramNotificationLevel;
    forwardChatFilter?: TelegramForwardChatFilter;
    forwardChatImportantPatterns?: string[];
  },
): TelegramSettings {
  const current = getManifestTelegramSettings();
  const userPatch = patch.user;
  const nextUser: TelegramUserSettings = userPatch
    ? {
        apiId:
          typeof userPatch.apiId === "number" && Number.isFinite(userPatch.apiId)
            ? Math.floor(userPatch.apiId)
            : current.user.apiId,
        apiHash:
          typeof userPatch.apiHash === "string"
            ? userPatch.apiHash.trim()
            : current.user.apiHash,
        session:
          typeof userPatch.session === "string"
            ? userPatch.session.trim()
            : current.user.session,
        targetChatId:
          typeof userPatch.targetChatId === "string"
            ? userPatch.targetChatId.trim()
            : current.user.targetChatId,
      }
    : current.user;
  const next: TelegramSettings = {
    botToken:
      typeof patch.botToken === "string"
        ? patch.botToken.trim()
        : current.botToken,
    chatId:
      typeof patch.chatId === "string" ? patch.chatId.trim() : current.chatId,
    user: nextUser,
    forwardChat:
      patch.forwardChat !== undefined
        ? normalizeForwardChat(patch.forwardChat)
        : current.forwardChat,
    forwardChatMinChars:
      patch.forwardChatMinChars !== undefined
        ? normalizeForwardChatMinChars(patch.forwardChatMinChars)
        : current.forwardChatMinChars,
    notificationLevel:
      patch.notificationLevel !== undefined
        ? normalizeNotificationLevel(patch.notificationLevel)
        : current.notificationLevel,
    forwardChatFilter:
      patch.forwardChatFilter !== undefined
        ? normalizeForwardChatFilter(patch.forwardChatFilter)
        : current.forwardChatFilter,
    forwardChatImportantPatterns:
      patch.forwardChatImportantPatterns !== undefined
        ? normalizeForwardChatImportantPatterns(patch.forwardChatImportantPatterns)
        : current.forwardChatImportantPatterns,
  };
  // Drop the section entirely when EVERY field is empty so bridge.json
  // doesn't carry a meaningless `telegram: { ... }`.
  const userEmpty =
    next.user.apiId === 0 &&
    next.user.apiHash === "" &&
    next.user.session === "" &&
    next.user.targetChatId === "";
  const importantPatternsDefault =
    next.forwardChatImportantPatterns.length === DEFAULT_FORWARD_CHAT_IMPORTANT_PATTERNS.length &&
    next.forwardChatImportantPatterns.every(
      (p, i) => p === DEFAULT_FORWARD_CHAT_IMPORTANT_PATTERNS[i],
    );
  const forwardChatDefault =
    next.forwardChat === DEFAULT_FORWARD_CHAT &&
    next.forwardChatMinChars === DEFAULT_FORWARD_CHAT_MIN_CHARS &&
    next.notificationLevel === DEFAULT_NOTIFICATION_LEVEL &&
    next.forwardChatFilter === DEFAULT_FORWARD_CHAT_FILTER &&
    importantPatternsDefault;
  const allEmpty =
    next.botToken === "" && next.chatId === "" && userEmpty && forwardChatDefault;
  const manifest = readManifest();
  const updatedManifest: BridgeManifest = { ...manifest };
  if (allEmpty) {
    delete (updatedManifest as { telegram?: TelegramSettings }).telegram;
  } else {
    // Build a terse on-disk shape: omit `user` when empty, and omit the
    // forwardChat fields when they're at default values, so bot-only
    // operators don't see noise in their manifest.
    const persisted: {
      botToken: string;
      chatId: string;
      user?: TelegramUserSettings;
      forwardChat?: TelegramForwardChat;
      forwardChatMinChars?: number;
      notificationLevel?: TelegramNotificationLevel;
      forwardChatFilter?: TelegramForwardChatFilter;
      forwardChatImportantPatterns?: string[];
    } = {
      botToken: next.botToken,
      chatId: next.chatId,
    };
    if (!userEmpty) persisted.user = next.user;
    if (next.forwardChat !== DEFAULT_FORWARD_CHAT) {
      persisted.forwardChat = next.forwardChat;
    }
    if (next.forwardChatMinChars !== DEFAULT_FORWARD_CHAT_MIN_CHARS) {
      persisted.forwardChatMinChars = next.forwardChatMinChars;
    }
    if (next.notificationLevel !== DEFAULT_NOTIFICATION_LEVEL) {
      persisted.notificationLevel = next.notificationLevel;
    }
    if (next.forwardChatFilter !== DEFAULT_FORWARD_CHAT_FILTER) {
      persisted.forwardChatFilter = next.forwardChatFilter;
    }
    if (!importantPatternsDefault) {
      persisted.forwardChatImportantPatterns = next.forwardChatImportantPatterns;
    }
    (updatedManifest as { telegram?: typeof persisted }).telegram = persisted;
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

/**
 * (Gap 2) Patch per-gate retry budgets on an app.
 *
 * Numeric value ≥ 0 → set; `null` / `undefined` → delete (revert to default).
 * Non-numeric / NaN values are dropped silently — the ladder clamps high
 * values to `MAX_RETRY_PER_GATE` at read time, so we accept any positive
 * integer here without further validation.
 */
export function updateAppRetry(
  name: string,
  patch: Partial<Record<keyof AppRetry, number | null | undefined>>,
): App | null {
  if (!isValidAppName(name)) return null;
  const apps = loadApps();
  const target = apps.find((a) => a.name === name);
  if (!target) return null;
  const next: AppRetry = { ...target.retry };
  for (const key of [
    "crash", "verify", "claim", "preflight", "style", "semantic",
  ] as const) {
    if (!Object.prototype.hasOwnProperty.call(patch, key)) continue;
    const v = patch[key];
    if (v === null || v === undefined) {
      delete next[key];
    } else if (typeof v === "number" && Number.isFinite(v) && v >= 0) {
      next[key] = Math.floor(v);
    }
    // non-numeric / NaN → drop silently (matches `normalizeRetry`)
  }
  target.retry = next;
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

/**
 * Per-marker weights for repo-likeness scoring. A folder needs to clear
 * `SCORE_THRESHOLD` to be promoted to a candidate. The split makes it
 * possible to score a `.git` folder strongly even if no other manifest
 * is present, while a lone `tsconfig.json` (common in tooling subdirs)
 * doesn't drag in noise.
 */
const STRONG_MARKERS: ReadonlyMap<string, number> = new Map([
  [".git", 10],
]);

const PROJECT_MARKERS: ReadonlyMap<string, number> = new Map([
  ["package.json", 6],
  ["pyproject.toml", 6],
  ["go.mod", 6],
  ["Cargo.toml", 6],
  ["pom.xml", 6],
  ["build.gradle", 6],
  ["build.gradle.kts", 6],
  ["Gemfile", 6],
  ["composer.json", 6],
  ["mix.exs", 6],
  ["Pipfile", 6],
  ["setup.py", 5],
  ["deno.json", 5],
  ["deno.jsonc", 5],
  ["flake.nix", 4],
  ["tsconfig.json", 4],
  ["requirements.txt", 4],
  ["setup.cfg", 4],
  ["Rakefile", 4],
  ["Dockerfile", 3],
  ["shell.nix", 3],
  ["Makefile", 2],
]);

const LOCKFILE_MARKERS: ReadonlyMap<string, number> = new Map([
  ["package-lock.json", 3],
  ["yarn.lock", 3],
  ["pnpm-lock.yaml", 3],
  ["bun.lockb", 3],
  ["bun.lock", 3],
  ["Cargo.lock", 3],
  ["Pipfile.lock", 3],
  ["poetry.lock", 3],
  ["composer.lock", 3],
  ["Gemfile.lock", 3],
  ["go.sum", 3],
]);

const MONOREPO_MARKERS = [
  "pnpm-workspace.yaml",
  "lerna.json",
  "turbo.json",
  "nx.json",
  "rush.json",
] as const;

/**
 * Common monorepo workspace folders. When a root repo declares itself a
 * monorepo, the detector also descends into these to surface workspace
 * children as separate candidates.
 */
const MONOREPO_CHILD_DIRS = ["packages", "apps", "services", "libs"] as const;

/** Minimum score for a folder to be promoted to a candidate. */
const SCORE_THRESHOLD = 5;

/** Hard cap on directories scanned per root. Stops a misconfigured root pointing at `~` from melting the host. */
const MAX_DIRS_PER_ROOT = 200;

const SKIP_DIRS = new Set([
  "node_modules", ".git", ".vscode", ".idea", "dist", "build",
  ".next", "out", ".turbo", ".cache", ".pnpm-store", ".bridge-state",
  ".uploads", ".playwright-mcp", "coverage", ".venv", "venv", "__pycache__",
  "target", "bin", "obj", ".gradle", ".mvn",
]);

interface RepoScore {
  score: number;
  signals: string[];
  isMonorepoRoot: boolean;
}

/**
 * Compute a repo-likeness score for a folder by summing marker weights.
 * `.git` alone qualifies; a manifest plus a lockfile is the typical
 * source-tree signature; a stray `tsconfig.json` in a tooling subdir
 * (weight 4) does not clear the threshold by itself.
 */
function scoreRepo(p: string): RepoScore {
  let score = 0;
  const signals: string[] = [];
  let isMonorepoRoot = false;
  for (const [marker, weight] of STRONG_MARKERS) {
    if (existsSync(join(p, marker))) { score += weight; signals.push(marker); }
  }
  for (const [marker, weight] of PROJECT_MARKERS) {
    if (existsSync(join(p, marker))) { score += weight; signals.push(marker); }
  }
  for (const [marker, weight] of LOCKFILE_MARKERS) {
    if (existsSync(join(p, marker))) { score += weight; signals.push(marker); }
  }
  for (const marker of MONOREPO_MARKERS) {
    if (existsSync(join(p, marker))) {
      isMonorepoRoot = true;
      score += 2; // small bump so monorepo roots themselves register too
      signals.push(marker);
    }
  }
  return { score, signals, isMonorepoRoot };
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

/**
 * Render an absolute path as the operator-friendly form we persist in
 * `bridge.json`. Sibling-of-bridge → `../<name>`, anything deeper than
 * one parent traversal stays absolute (more readable, no surprise).
 */
function formatRawPath(absPath: string): string {
  const rel = relative(BRIDGE_ROOT, absPath).replace(/\\/g, "/");
  if (!rel || rel === ".") return absPath;
  // Allow at most one `..` segment in a relative form. Deep traversals
  // turn into mostly-`../` ladders that are harder to read than the
  // absolute path.
  const parentLadder = rel.match(/^(\.\.\/)+/)?.[0] ?? "";
  if (parentLadder.length > 3) return absPath;
  return rel;
}

/**
 * Coerce a folder name into a valid app name slug. The detection layer
 * only proposes candidates whose folder name is already valid (the UI
 * shows the suggestion and the user can rename in the modal), but the
 * monorepo path produces composite names like `mono__pkg-web` so we
 * sanitize defensively.
 */
function suggestAppName(raw: string, taken: Set<string>): string {
  let base = raw.replace(/[^A-Za-z0-9._-]/g, "-").replace(/^-+|-+$/g, "");
  if (!base || !/^[A-Za-z0-9]/.test(base)) base = `app-${base}`.replace(/^-+|-+$/g, "");
  if (!APP_NAME_RE.test(base)) base = "app";
  let name = base;
  let n = 2;
  while (taken.has(name)) {
    name = `${base}-${n++}`;
  }
  return name;
}

export interface DetectCandidate {
  /** Suggested registration name (folder name, slugified + de-duped). */
  name: string;
  /** Path the user would see in `bridge.json` (relative or absolute). */
  rawPath: string;
  /** Resolved absolute path on disk. */
  absolutePath: string;
  description: string;
  /** Marker filenames that fired during scoring. */
  signals: string[];
  /** Total weighted score; ≥ SCORE_THRESHOLD to qualify. */
  score: number;
  /** True when an existing app entry already points at this folder. */
  alreadyRegistered: boolean;
  /** True when this candidate is a child of a workspace root (e.g. `apps/web`). */
  isMonorepoChild: boolean;
}

export type DetectEvent =
  | { type: "started"; roots: string[]; depth: number }
  | { type: "scanning"; root: string }
  | { type: "candidate"; candidate: DetectCandidate }
  | { type: "skipped"; path: string; reason: "not-a-repo" | "already-scanned" | "permission" | "max-dirs" }
  | { type: "done"; candidates: number; alreadyRegistered: number; scanned: number };

export interface DetectOptions {
  /** Absolute or relative-to-BRIDGE_ROOT roots. Empty / undefined → bridge parent. */
  roots?: string[];
  /** Plain recursion depth into non-repo folders. Defaults to 1 (children only). Capped at 3. */
  depth?: number;
  /** Streaming hook — fires for every event so the SSE route can flush incrementally. */
  onEvent?: (ev: DetectEvent) => void | Promise<void>;
  /** Aborts early when fired (client disconnect). */
  signal?: AbortSignal;
}

/**
 * Pure detection — scans `roots` for code repos and emits candidates
 * via `onEvent`. Does NOT mutate `bridge.json`. Callers (the UI confirm
 * flow, or `autoDetectApps` for backward compat) decide which
 * candidates to add.
 *
 * Smart parts vs. the previous one-tier scan:
 *   - Marker scoring (≥ 5) instead of any-marker, so a stray
 *     `tsconfig.json` in a tooling folder no longer registers.
 *   - Multi-root, configurable via `roots[]` and persisted via
 *     `set/getManifestDetectScanRoots`. Default still = bridge parent.
 *   - Monorepo aware: workspace roots additionally surface
 *     `packages/*`, `apps/*`, `services/*`, `libs/*` as separate
 *     candidates (folder name suggestion is the workspace child, with
 *     a slug-disambiguator if it collides).
 *   - `depth` controls plain recursion into non-repo folders for
 *     operators whose code lives 1–2 levels under the configured root.
 */
export async function detectAppCandidates(
  opts: DetectOptions = {},
): Promise<DetectCandidate[]> {
  const depth = Math.min(3, Math.max(1, opts.depth ?? 1));
  const requestedRoots = (opts.roots ?? [])
    .map((r) => r.trim())
    .filter((r) => r.length > 0);
  const rootsAbs = (requestedRoots.length > 0 ? requestedRoots : [dirname(BRIDGE_ROOT)])
    .map((r) => (isAbsolute(r) ? resolve(r) : resolve(BRIDGE_ROOT, r)));

  const existing = loadApps();
  const knownNames = new Set(existing.map((a) => a.name));
  const knownPaths = new Set(existing.map((a) => a.path));

  const emit = async (ev: DetectEvent) => {
    try { await opts.onEvent?.(ev); } catch { /* never let the consumer kill the scan */ }
  };

  await emit({ type: "started", roots: rootsAbs, depth });

  const candidates: DetectCandidate[] = [];
  const visited = new Set<string>();
  // Names taken by existing apps + already-emitted candidates, so the
  // suggestion logic can pick a non-conflicting slug.
  const takenNames = new Set(knownNames);
  let totalScanned = 0;
  let totalAlreadyRegistered = 0;

  for (const root of rootsAbs) {
    if (opts.signal?.aborted) break;
    await emit({ type: "scanning", root });

    const queue: { path: string; depthLeft: number; isMonorepoChild: boolean }[] = [
      { path: root, depthLeft: depth, isMonorepoChild: false },
    ];
    let dirsForRoot = 0;

    while (queue.length > 0) {
      if (opts.signal?.aborted) break;
      const { path: dir, depthLeft, isMonorepoChild } = queue.shift()!;
      if (visited.has(dir)) continue;
      visited.add(dir);
      if (++dirsForRoot > MAX_DIRS_PER_ROOT) {
        await emit({ type: "skipped", path: dir, reason: "max-dirs" });
        break;
      }

      let entries: import("node:fs").Dirent[];
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch (err) {
        await emit({ type: "skipped", path: dir, reason: "permission" });
        console.warn("detect: cannot read", dir, (err as Error).message);
        continue;
      }

      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        if (entry.name.startsWith(".")) continue;
        if (SKIP_DIRS.has(entry.name)) continue;
        const childPath = join(dir, entry.name);
        if (childPath === BRIDGE_ROOT) continue;
        if (visited.has(childPath)) continue;

        totalScanned += 1;
        // Yield to the event loop every few stat-batches so the SSE
        // route can flush — Node's fs is sync but the runtime needs a
        // microtask break to push bytes.
        if (totalScanned % 8 === 0) await new Promise((r) => setTimeout(r, 0));

        const repoScore = scoreRepo(childPath);
        const qualifies = repoScore.score >= SCORE_THRESHOLD;

        if (qualifies) {
          if (knownPaths.has(childPath)) {
            totalAlreadyRegistered += 1;
            await emit({
              type: "candidate",
              candidate: {
                name: existing.find((a) => a.path === childPath)?.name ?? entry.name,
                rawPath: formatRawPath(childPath),
                absolutePath: childPath,
                description: existing.find((a) => a.path === childPath)?.description ?? "",
                signals: repoScore.signals,
                score: repoScore.score,
                alreadyRegistered: true,
                isMonorepoChild,
              },
            });
            // Don't recurse into a registered repo's children — registered
            // implies the operator already has the granularity they want.
            continue;
          }
          const suggestedName = suggestAppName(entry.name, takenNames);
          takenNames.add(suggestedName);
          const candidate: DetectCandidate = {
            name: suggestedName,
            rawPath: formatRawPath(childPath),
            absolutePath: childPath,
            description: deriveDescription(childPath),
            signals: repoScore.signals,
            score: repoScore.score,
            alreadyRegistered: false,
            isMonorepoChild,
          };
          candidates.push(candidate);
          await emit({ type: "candidate", candidate });

          // Monorepo: descend into workspace dirs to surface members as
          // their own candidates, regardless of `depth`. Cap depth on
          // the monorepo path so we don't double-recurse.
          if (repoScore.isMonorepoRoot) {
            for (const wsDir of MONOREPO_CHILD_DIRS) {
              const wsPath = join(childPath, wsDir);
              if (existsSync(wsPath)) {
                queue.push({ path: wsPath, depthLeft: 1, isMonorepoChild: true });
              }
            }
          }
          continue;
        }

        // Folder doesn't itself qualify. Recurse into it if depth allows
        // — useful for operators whose code lives one level under the
        // configured root (e.g. `~/work/<client>/<repo>`).
        if (depthLeft > 1) {
          queue.push({ path: childPath, depthLeft: depthLeft - 1, isMonorepoChild });
        } else {
          await emit({ type: "skipped", path: childPath, reason: "not-a-repo" });
        }
      }
    }
  }

  await emit({
    type: "done",
    candidates: candidates.length,
    alreadyRegistered: totalAlreadyRegistered,
    scanned: totalScanned,
  });
  return candidates;
}

export interface AutoDetectResult {
  added: App[];
  skipped: { name: string; reason: "already-registered" | "not-a-repo" }[];
}

/**
 * Backward-compat wrapper over `detectAppCandidates` for the Telegram
 * `/scan` command and any non-UI caller. Auto-confirms every candidate
 * (no review modal — the Telegram surface can't render one).
 */
export async function autoDetectApps(): Promise<AutoDetectResult> {
  const candidates = await detectAppCandidates();
  const added: App[] = [];
  const skipped: AutoDetectResult["skipped"] = [];

  for (const c of candidates) {
    if (c.alreadyRegistered) {
      skipped.push({ name: c.name, reason: "already-registered" });
      continue;
    }
    const result = addApp({ name: c.name, path: c.rawPath, description: c.description });
    if (result.ok) added.push(result.app);
    else skipped.push({ name: c.name, reason: "not-a-repo" });
  }
  return { added, skipped };
}

/**
 * Read the operator's saved scan roots from `bridge.json` (under the
 * shared `detect.*` block alongside `detect.source`). Empty array
 * means "use default" — i.e. `dirname(BRIDGE_ROOT)`. The detector
 * reads this on first open of the auto-detect modal so the operator
 * doesn't have to retype paths each session.
 */
export function getManifestDetectScanRoots(): string[] {
  const m = readManifest();
  const det = (m as { detect?: { scanRoots?: unknown } }).detect;
  return normalizeStringList(det?.scanRoots);
}

/**
 * Persist scan roots. Empty input clears the field entirely so
 * `bridge.json` stays terse for default-config operators.
 */
export function setManifestDetectScanRoots(roots: string[]): string[] {
  const cleaned = normalizeStringList(roots);
  const manifest = readManifest();
  const detPrev = (manifest as { detect?: Record<string, unknown> }).detect ?? {};
  const detNext: Record<string, unknown> = { ...detPrev };
  if (cleaned.length === 0) delete detNext.scanRoots;
  else detNext.scanRoots = cleaned;
  const next = { ...manifest } as BridgeManifest;
  if (Object.keys(detNext).length === 0) {
    delete (next as { detect?: unknown }).detect;
  } else {
    (next as { detect?: Record<string, unknown> }).detect = detNext;
  }
  writeManifest(next);
  return cleaned;
}
