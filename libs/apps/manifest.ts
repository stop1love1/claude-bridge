
import { existsSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { BRIDGE_ROOT } from "../paths";
import {
  BRIDGE_JSON,
  onBridgeManifestWrite,
  readBridgeManifest,
  updateBridgeManifest,
} from "../bridgeManifest";
import type {
  App,
  AppDispatch,
  AppGitSettings,
  AppMemory,
  AppQuality,
  AppRetry,
  AppVerify,
  BridgeManifest,
  GitBranchMode,
  GitIntegrationMode,
  GitWorktreeMode,
  ManifestAppEntry,
  SpeculativeAngle,
} from "./types";
import {
  DEFAULT_APP_DISPATCH,
  DEFAULT_APP_MEMORY,
  DEFAULT_APP_RETRY,
  DEFAULT_GIT_SETTINGS,
  DEFAULT_QUALITY,
  DEFAULT_VERIFY,
} from "./types";

export const APP_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const SCHEMA_VERSION = 1;

export function isValidAppName(name: unknown): name is string {
  return typeof name === "string" && APP_NAME_RE.test(name);
}

export function resolveAppPath(rawPath: string): string {
  if (!rawPath) return rawPath;
  return isAbsolute(rawPath) ? resolve(rawPath) : resolve(BRIDGE_ROOT, rawPath);
}

export function readManifest(): BridgeManifest {
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

export function normalizeVerify(raw: unknown): AppVerify {
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

export function normalizeStringList(raw: unknown): string[] {
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
