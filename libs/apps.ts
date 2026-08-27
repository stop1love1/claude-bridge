
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, isAbsolute, join, normalize, relative, resolve } from "node:path";
import { BRIDGE_ROOT } from "./paths";
import {
  BRIDGE_JSON,
  onBridgeManifestWrite,
  readBridgeManifest,
  updateBridgeManifest,
} from "./bridgeManifest";
import { validateAppPath, type PathGuardFail } from "./pathGuard";
import { detectVerifyCommands } from "./verifyDetect";

export type GitBranchMode = "current" | "fixed" | "auto-create";

export type GitWorktreeMode = "disabled" | "enabled";

export type GitIntegrationMode = "none" | "auto-merge" | "pull-request";

export interface AppGitSettings {
  branchMode: GitBranchMode;
  fixedBranch: string;
  autoCommit: boolean;
  autoPush: boolean;
  worktreeMode: GitWorktreeMode;
  mergeTargetBranch: string;
  integrationMode: GitIntegrationMode;
  pushTimeoutMs?: number;
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

export const RECOMMENDED_GIT_SETTINGS: AppGitSettings = {
  branchMode: "auto-create",
  fixedBranch: "",
  autoCommit: true,
  autoPush: false,
  worktreeMode: "disabled",
  mergeTargetBranch: "",
  integrationMode: "none",
};

export interface AppVerify {
  test?: string;
  lint?: string;
  build?: string;
  typecheck?: string;
  format?: string;
}

export const DEFAULT_VERIFY: AppVerify = {};

export interface AppQuality {
  critic?: boolean;
  verifier?: boolean;
  verifierPanel?: number;
  criticPanel?: number;
}

export const DEFAULT_QUALITY: AppQuality = {};

export function semanticVerifierEnabled(app: Pick<App, "quality">): boolean {
  return app.quality?.verifier !== false;
}

export function resolvePanelSize(app: Pick<App, "quality">): number {
  const n = app.quality?.verifierPanel;
  if (typeof n !== "number" || !Number.isFinite(n)) return 3;
  return Math.max(1, Math.min(5, Math.floor(n)));
}

export function resolveCriticPanelSize(app: Pick<App, "quality">): number {
  const n = app.quality?.criticPanel;
  if (typeof n !== "number" || !Number.isFinite(n)) return 3;
  return Math.max(1, Math.min(5, Math.floor(n)));
}

export interface AppRetry {
  crash?: number;
  verify?: number;
  claim?: number;
  preflight?: number;
  style?: number;
  semantic?: number;
  totalCap?: number;
}

export const DEFAULT_APP_RETRY: AppRetry = {};

export interface AppMemory {
  distill?: boolean;
}

export const DEFAULT_APP_MEMORY: AppMemory = {};

export interface AppDispatch {
  speculative?: {
    enabled?: boolean;
    n?: number;
    roles?: string[];
    angles?: SpeculativeAngle[];
  };
}

export interface SpeculativeAngle {
  label: string;
  nudge: string;
}

export const DEFAULT_APP_DISPATCH: AppDispatch = {};

export interface App {
  name: string;
  path: string;
  rawPath: string;
  description: string;
  git: AppGitSettings;
  verify: AppVerify;
  pinnedFiles: string[];
  symbolDirs: string[];
  quality: AppQuality;
  retry: AppRetry;
  memory: AppMemory;
  dispatch: AppDispatch;
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

function normalizeGitSettings(raw: unknown): AppGitSettings {
  if (!raw || typeof raw !== "object") return { ...DEFAULT_GIT_SETTINGS };
  const r = raw as Partial<AppGitSettings>;
  const branchMode: GitBranchMode =
    r.branchMode === "fixed" || r.branchMode === "auto-create" ? r.branchMode : "current";
  const fixedBranch = typeof r.fixedBranch === "string" ? r.fixedBranch.trim() : "";
  const mergeTargetBranch =
    typeof r.mergeTargetBranch === "string" ? r.mergeTargetBranch.trim() : "";
  let integrationMode: GitIntegrationMode =
    r.integrationMode === "auto-merge" || r.integrationMode === "pull-request"
      ? r.integrationMode
      : "none";
  if (integrationMode === "none" && mergeTargetBranch.length > 0 && r.integrationMode === undefined) {
    integrationMode = "auto-merge";
  }
  if (integrationMode !== "none" && mergeTargetBranch.length === 0) {
    integrationMode = "none";
  }
  const autoCommit =
    r.autoCommit === true || r.autoPush === true || integrationMode !== "none";
  const autoPush = r.autoPush === true || integrationMode === "pull-request";
  const worktreeMode: GitWorktreeMode =
    r.worktreeMode === "enabled" ? "enabled" : "disabled";
  const pushTimeoutMs = normalizePushTimeout(r.pushTimeoutMs);
  return {
    branchMode,
    fixedBranch,
    autoCommit,
    autoPush,
    worktreeMode,
    mergeTargetBranch,
    integrationMode,
    ...(pushTimeoutMs !== undefined ? { pushTimeoutMs } : {}),
  };
}

function normalizePushTimeout(raw: unknown): number | undefined {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return undefined;
  const n = Math.floor(raw);
  if (n < 5_000 || n > 600_000) return undefined;
  return n;
}

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

function normalizeQuality(raw: unknown): AppQuality {
  if (!raw || typeof raw !== "object") return { ...DEFAULT_QUALITY };
  const r = raw as Partial<Record<keyof AppQuality, unknown>>;
  const out: AppQuality = {};
  if (r.critic === true) out.critic = true;
  if (r.verifier === true) out.verifier = true;
  else if (r.verifier === false) out.verifier = false;
  if (typeof r.verifierPanel === "number" && Number.isFinite(r.verifierPanel)) {
    out.verifierPanel = Math.floor(r.verifierPanel);
  }
  if (typeof r.criticPanel === "number" && Number.isFinite(r.criticPanel)) {
    out.criticPanel = Math.floor(r.criticPanel);
  }
  return out;
}

function normalizeRetry(raw: unknown): AppRetry {
  if (!raw || typeof raw !== "object") return { ...DEFAULT_APP_RETRY };
  const r = raw as Partial<Record<keyof AppRetry, unknown>>;
  const out: AppRetry = {};
  for (const key of [
    "crash", "verify", "claim", "preflight", "style", "semantic", "totalCap",
  ] as const) {
    const v = r[key];
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0) continue;
    out[key] = Math.floor(v);
  }
  return out;
}

function serializeRetry(r: AppRetry | undefined): AppRetry | undefined {
  if (!r) return undefined;
  const out: AppRetry = {};
  for (const key of [
    "crash", "verify", "claim", "preflight", "style", "semantic", "totalCap",
  ] as const) {
    const v = r[key];
    if (typeof v === "number" && Number.isFinite(v) && v >= 0) {
      out[key] = Math.floor(v);
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function serializeQuality(q: AppQuality | undefined): AppQuality | undefined {
  if (!q) return undefined;
  const out: AppQuality = {};
  if (q.critic === true) out.critic = true;
  if (q.verifier === true) out.verifier = true;
  else if (q.verifier === false) out.verifier = false;
  if (typeof q.verifierPanel === "number" && Number.isFinite(q.verifierPanel)) {
    out.verifierPanel = Math.floor(q.verifierPanel);
  }
  if (typeof q.criticPanel === "number" && Number.isFinite(q.criticPanel)) {
    out.criticPanel = Math.floor(q.criticPanel);
  }
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
  const s = sRaw as {
    enabled?: unknown;
    n?: unknown;
    roles?: unknown;
    angles?: unknown;
  };
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
  const angles = normalizeSpeculativeAngles(s.angles);
  const speculative: NonNullable<AppDispatch["speculative"]> = {
    enabled: true,
    n,
    roles,
  };
  if (angles.length > 0) speculative.angles = angles;
  return { speculative };
}

function normalizeSpeculativeAngles(raw: unknown): SpeculativeAngle[] {
  if (!Array.isArray(raw)) return [];
  const out: SpeculativeAngle[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as { label?: unknown; nudge?: unknown };
    if (typeof e.label !== "string" || typeof e.nudge !== "string") continue;
    const label = e.label.trim().slice(0, 40);
    const nudge = e.nudge.trim().slice(0, 600);
    if (label.length === 0 || nudge.length === 0) continue;
    out.push({ label, nudge });
  }
  return out.slice(0, SPECULATIVE_MAX_N);
}

function serializeDispatch(d: AppDispatch | undefined): AppDispatch | undefined {
  if (!d || !d.speculative || !d.speculative.enabled) return undefined;
  const speculative: NonNullable<AppDispatch["speculative"]> = {
    enabled: true,
    n: d.speculative.n ?? SPECULATIVE_DEFAULT_N,
    roles: d.speculative.roles ?? [...SPECULATIVE_DEFAULT_ROLES],
  };
  if (d.speculative.angles && d.speculative.angles.length > 0) {
    speculative.angles = d.speculative.angles.map((a) => ({
      label: a.label,
      nudge: a.nudge,
    }));
  }
  return { speculative };
}

function serializeStringList(arr: string[] | undefined): string[] | undefined {
  if (!arr || arr.length === 0) return undefined;
  const trimmed = arr.map((s) => s.trim()).filter((s) => s.length > 0);
  return trimmed.length > 0 ? trimmed : undefined;
}

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
  if (typeof g.pushTimeoutMs === "number" && g.pushTimeoutMs > 0) {
    out.pushTimeoutMs = g.pushTimeoutMs;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

export function parseApps(json: string): App[] {
  if (!json || !json.trim()) return [];
  let parsed: Partial<BridgeManifest>;
  try { parsed = JSON.parse(json) as Partial<BridgeManifest>; }
  catch { return []; }
  return parseAppsFromManifest(parsed);
}

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

const APPS_CACHE_TTL_MS = 1000;
let appsCache: { value: App[]; expires: number } | null = null;
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
  const serialized: ManifestAppEntry[] = apps.map((a) => {
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
  updateBridgeManifest((m) => ({
    ...m,
    version: SCHEMA_VERSION,
    apps: serialized,
  }));
  appsCache = null;
}

export function getApp(name: string): App | null {
  if (!isValidAppName(name)) return null;
  return loadApps().find((a) => a.name === name) ?? null;
}

function pathsEqualFilesystem(a: string, b: string): boolean {
  if (a === b) return true;
  try {
    return normalize(a) === normalize(b);
  } catch {
    return false;
  }
}

function safeDecodeURIComponent(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

export function resolveAppFromRouteSegment(segment: string): App | null {
  if (typeof segment !== "string" || segment.length === 0 || segment.length > 12_000) {
    return null;
  }
  const decoded = safeDecodeURIComponent(segment);
  const apps = loadApps();

  for (const app of apps) {
    if (pathsEqualFilesystem(app.path, decoded)) return app;
  }

  let decodedResolved: string | null = null;
  try {
    decodedResolved = resolveAppPath(decoded);
  } catch {
    decodedResolved = null;
  }
  if (decodedResolved) {
    for (const app of apps) {
      if (pathsEqualFilesystem(app.path, decodedResolved)) return app;
    }
  }

  for (const app of apps) {
    if (app.rawPath === decoded || app.rawPath === segment) return app;
  }

  if (!isValidAppName(decoded)) return null;
  const byName = apps.filter((a) => a.name === decoded);
  if (byName.length === 1) return byName[0];
  return null;
}

export function applyRecommendedPreset(app: App): App {
  const git: AppGitSettings = { ...app.git };
  if (git.branchMode === DEFAULT_GIT_SETTINGS.branchMode) {
    git.branchMode = RECOMMENDED_GIT_SETTINGS.branchMode;
  }
  if (git.fixedBranch === DEFAULT_GIT_SETTINGS.fixedBranch) {
    git.fixedBranch = RECOMMENDED_GIT_SETTINGS.fixedBranch;
  }
  if (git.autoCommit === DEFAULT_GIT_SETTINGS.autoCommit) {
    git.autoCommit = RECOMMENDED_GIT_SETTINGS.autoCommit;
  }
  if (git.autoPush === DEFAULT_GIT_SETTINGS.autoPush) {
    git.autoPush = RECOMMENDED_GIT_SETTINGS.autoPush;
  }
  if (git.worktreeMode === DEFAULT_GIT_SETTINGS.worktreeMode) {
    git.worktreeMode = RECOMMENDED_GIT_SETTINGS.worktreeMode;
  }
  if (git.mergeTargetBranch === DEFAULT_GIT_SETTINGS.mergeTargetBranch) {
    git.mergeTargetBranch = RECOMMENDED_GIT_SETTINGS.mergeTargetBranch;
  }
  if (git.integrationMode === DEFAULT_GIT_SETTINGS.integrationMode) {
    git.integrationMode = RECOMMENDED_GIT_SETTINGS.integrationMode;
  }
  return {
    ...app,
    git,
    quality: { ...app.quality, critic: true },
  };
}

export interface AppInput {
  name: string;
  path: string;
  description?: string;
  verify?: AppVerify;
  preset?: "recommended";
}

export interface AddAppResult {
  ok: true;
  app: App;
}

export interface AddAppFailure {
  ok: false;
  reason:
    | "invalid-name"
    | "missing-path"
    | "duplicate-name"
    | PathGuardFail["reason"];
  detail?: string;
}

export function addApp(input: AppInput): AddAppResult | AddAppFailure {
  if (!isValidAppName(input.name)) return { ok: false, reason: "invalid-name" };
  const rawPath = (input.path ?? "").trim();
  if (rawPath.length === 0) return { ok: false, reason: "missing-path" };
  const guard = validateAppPath(rawPath);
  if (!guard.ok) return { ok: false, reason: guard.reason, detail: guard.detail };
  const apps = loadApps();
  if (apps.some((a) => a.name === input.name)) {
    return { ok: false, reason: "duplicate-name" };
  }
  const operatorVerify = normalizeVerify(input.verify);
  const verify =
    Object.keys(operatorVerify).length > 0
      ? operatorVerify
      : detectVerifyCommands(guard.resolvedPath);
  let app: App = {
    name: input.name,
    rawPath,
    path: guard.resolvedPath,
    description: (input.description ?? "").trim(),
    git: { ...DEFAULT_GIT_SETTINGS },
    verify,
    pinnedFiles: [],
    symbolDirs: [],
    quality: { ...DEFAULT_QUALITY },
    capabilities: [],
    retry: { ...DEFAULT_APP_RETRY },
    memory: { ...DEFAULT_APP_MEMORY },
    dispatch: { ...DEFAULT_APP_DISPATCH },
  };
  if (input.preset === "recommended") {
    app = applyRecommendedPreset(app);
  }
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

export function updateAppDescription(name: string, description: string): App | null {
  if (!isValidAppName(name)) return null;
  const apps = loadApps();
  const target = apps.find((a) => a.name === name);
  if (!target) return null;
  target.description = (description ?? "").trim();
  saveApps(apps);
  return target;
}

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

function isVerifyEmpty(v: AppVerify | undefined): boolean {
  if (!v) return true;
  return !["test", "lint", "build", "typecheck", "format"].some((key) => {
    const val = (v as Record<string, unknown>)[key];
    return typeof val === "string" && val.trim().length > 0;
  });
}

export function backfillAppVerifyIfEmpty(name: string): App | null {
  if (!isValidAppName(name)) return null;
  const apps = loadApps();
  const target = apps.find((a) => a.name === name);
  if (!target) return null;
  if (!isVerifyEmpty(target.verify)) return target;
  const detected = detectVerifyCommands(target.path);
  if (isVerifyEmpty(detected)) return target;
  target.verify = detected;
  saveApps(apps);
  return target;
}

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

export type DetectManifestSource = "auto" | "llm" | "heuristic";

export function getManifestDetectSource(): DetectManifestSource {
  const m = readManifest();
  const det = (m as { detect?: { source?: unknown } }).detect;
  const s = det?.source;
  if (s === "llm" || s === "heuristic" || s === "auto") return s;
  return "auto";
}

export function setManifestDetectSource(source: DetectManifestSource): void {
  updateBridgeManifest((m) => ({ ...m, detect: { source } }));
}

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
  return parsed.origin;
}

export function getManifestPublicUrl(): string {
  const m = readManifest();
  return normalizePublicUrl((m as { publicUrl?: unknown }).publicUrl);
}

export function setManifestPublicUrl(input: string): string {
  const normalized = normalizePublicUrl(input);
  const explicitClear = typeof input === "string" && input.trim() === "";
  if (!normalized && !explicitClear && typeof input === "string") {
    return getManifestPublicUrl();
  }
  updateBridgeManifest((m) => {
    const next: BridgeManifest = { ...(m as BridgeManifest) };
    if (normalized) {
      (next as { publicUrl?: string }).publicUrl = normalized;
    } else {
      delete (next as { publicUrl?: string }).publicUrl;
    }
    return next;
  });
  return normalized;
}

export interface TunnelAutoStart {
  enabled: boolean;
  provider: "localtunnel" | "ngrok";
  port: number;
}

interface TunnelsManifestSection {
  autoStart?: TunnelAutoStart;
  [key: string]: unknown;
}

export function getTunnelAutoStart(): TunnelAutoStart | null {
  const m = readManifest();
  const tunnels = (m as { tunnels?: TunnelsManifestSection }).tunnels;
  const a = tunnels?.autoStart;
  if (!a || typeof a !== "object") return null;
  const provider =
    a.provider === "ngrok" ? "ngrok" : a.provider === "localtunnel" ? "localtunnel" : null;
  const port = Number(a.port);
  if (!provider || !Number.isInteger(port) || port < 1 || port > 65535) return null;
  return { enabled: a.enabled === true, provider, port };
}

export function setTunnelAutoStart(v: TunnelAutoStart | null): void {
  updateBridgeManifest((m) => {
    const next: BridgeManifest = { ...(m as BridgeManifest) };
    const tunnels: TunnelsManifestSection = {
      ...((next.tunnels as TunnelsManifestSection | undefined) ?? {}),
    };
    if (v) {
      tunnels.autoStart = { enabled: v.enabled, provider: v.provider, port: v.port };
    } else {
      delete tunnels.autoStart;
    }
    if (Object.keys(tunnels).length > 0) {
      (next as { tunnels?: TunnelsManifestSection }).tunnels = tunnels;
    } else {
      delete (next as { tunnels?: TunnelsManifestSection }).tunnels;
    }
    return next;
  });
}

export interface TelegramUserSettings {
  apiId: number;
  apiHash: string;
  session: string;
  targetChatId: string;
}

export const DEFAULT_TELEGRAM_USER_SETTINGS: TelegramUserSettings = {
  apiId: 0,
  apiHash: "",
  session: "",
  targetChatId: "",
};

export type TelegramForwardChat = "off" | "coordinator-only" | "all";

export const DEFAULT_FORWARD_CHAT: TelegramForwardChat = "off";
export const DEFAULT_FORWARD_CHAT_MIN_CHARS = 40;

export type TelegramNotificationLevel = "minimal" | "normal" | "verbose";

export const DEFAULT_NOTIFICATION_LEVEL: TelegramNotificationLevel = "normal";

export type TelegramForwardChatFilter = "important-only" | "all";

export const DEFAULT_FORWARD_CHAT_FILTER: TelegramForwardChatFilter =
  "important-only";

export interface TelegramSettings {
  botToken: string;
  chatId: string;
  user: TelegramUserSettings;
  forwardChat: TelegramForwardChat;
  forwardChatMinChars: number;
  notificationLevel: TelegramNotificationLevel;
  forwardChatFilter: TelegramForwardChatFilter;
  forwardChatImportantPatterns: string[];
}

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
  updateBridgeManifest((m) => {
    const updatedManifest: BridgeManifest = { ...(m as BridgeManifest) };
    if (allEmpty) {
      delete (updatedManifest as { telegram?: TelegramSettings }).telegram;
    } else {
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
    return updatedManifest;
  });
  return next;
}

export function updateAppQuality(
  name: string,
  patch: Partial<AppQuality>,
): App | null {
  if (!isValidAppName(name)) return null;
  const apps = loadApps();
  const target = apps.find((a) => a.name === name);
  if (!target) return null;
  const next: AppQuality = { ...target.quality };
  if (Object.prototype.hasOwnProperty.call(patch, "critic")) {
    if (patch.critic === true) next.critic = true;
    else delete next.critic;
  }
  if (Object.prototype.hasOwnProperty.call(patch, "verifier")) {
    if (patch.verifier === true) next.verifier = true;
    else if (patch.verifier === false) next.verifier = false;
    else delete next.verifier;
  }
  if (Object.prototype.hasOwnProperty.call(patch, "verifierPanel")) {
    if (typeof patch.verifierPanel === "number" && Number.isFinite(patch.verifierPanel)) {
      next.verifierPanel = Math.floor(patch.verifierPanel);
    } else {
      delete next.verifierPanel;
    }
  }
  if (Object.prototype.hasOwnProperty.call(patch, "criticPanel")) {
    if (typeof patch.criticPanel === "number" && Number.isFinite(patch.criticPanel)) {
      next.criticPanel = Math.floor(patch.criticPanel);
    } else {
      delete next.criticPanel;
    }
  }
  target.quality = next;
  saveApps(apps);
  return target;
}

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

const MONOREPO_CHILD_DIRS = ["packages", "apps", "services", "libs"] as const;

const SCORE_THRESHOLD = 5;

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
      score += 2;
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
    } catch { }
  }
  return "";
}

function formatRawPath(absPath: string): string {
  const rel = relative(BRIDGE_ROOT, absPath).replace(/\\/g, "/");
  if (!rel || rel === ".") return absPath;
  const parentLadder = rel.match(/^(\.\.\/)+/)?.[0] ?? "";
  if (parentLadder.length > 3) return absPath;
  return rel;
}

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
  name: string;
  rawPath: string;
  absolutePath: string;
  description: string;
  signals: string[];
  score: number;
  alreadyRegistered: boolean;
  isMonorepoChild: boolean;
}

export type DetectEvent =
  | { type: "started"; roots: string[]; depth: number }
  | { type: "scanning"; root: string }
  | { type: "candidate"; candidate: DetectCandidate }
  | { type: "skipped"; path: string; reason: "not-a-repo" | "already-scanned" | "permission" | "max-dirs" }
  | { type: "done"; candidates: number; alreadyRegistered: number; scanned: number };

export interface DetectOptions {
  roots?: string[];
  depth?: number;
  onEvent?: (ev: DetectEvent) => void | Promise<void>;
  signal?: AbortSignal;
}

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
    try { await opts.onEvent?.(ev); } catch { }
  };

  await emit({ type: "started", roots: rootsAbs, depth });

  const candidates: DetectCandidate[] = [];
  const visited = new Set<string>();
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

export function getManifestDetectScanRoots(): string[] {
  const m = readManifest();
  const det = (m as { detect?: { scanRoots?: unknown } }).detect;
  return normalizeStringList(det?.scanRoots);
}

export function setManifestDetectScanRoots(roots: string[]): string[] {
  const cleaned = normalizeStringList(roots);
  updateBridgeManifest((m) => {
    const detPrev = (m as { detect?: Record<string, unknown> }).detect ?? {};
    const detNext: Record<string, unknown> = { ...detPrev };
    if (cleaned.length === 0) delete detNext.scanRoots;
    else detNext.scanRoots = cleaned;
    const next = { ...(m as BridgeManifest) };
    if (Object.keys(detNext).length === 0) {
      delete (next as { detect?: unknown }).detect;
    } else {
      (next as { detect?: Record<string, unknown> }).detect = detNext;
    }
    return next;
  });
  return cleaned;
}
