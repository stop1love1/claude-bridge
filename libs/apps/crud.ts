
import { normalize } from "node:path";
import { validateAppPath, type PathGuardFail } from "../pathGuard";
import { detectVerifyCommands } from "../verifyDetect";
import { isValidModel } from "../validate";
import type {
  App,
  AppGitSettings,
  AppQuality,
  AppRetry,
  AppRoleModels,
  AppVerify,
} from "./types";
import {
  DEFAULT_APP_DISPATCH,
  DEFAULT_APP_MEMORY,
  DEFAULT_APP_RETRY,
  DEFAULT_GIT_SETTINGS,
  DEFAULT_QUALITY,
  RECOMMENDED_GIT_SETTINGS,
} from "./types";
import {
  isValidAppName,
  loadApps,
  normalizeStringList,
  normalizeVerify,
  resolveAppPath,
  saveApps,
} from "./manifest";

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

/**
 * Sets or clears this app's per-role model pins. A key mapped to `null` is
 * removed; a key mapped to an invalid model is ignored rather than persisted,
 * so a bad value can never end up in `bridge.json` where dispatch would have
 * to keep re-rejecting it.
 */
export function updateAppRoleModels(
  name: string,
  patch: Record<string, string | null | undefined>,
): App | null {
  if (!isValidAppName(name)) return null;
  const apps = loadApps();
  const target = apps.find((a) => a.name === name);
  if (!target) return null;
  const next: AppRoleModels = { ...(target.roleModels ?? {}) };
  for (const [key, value] of Object.entries(patch)) {
    if (value === null || value === undefined || value === "") {
      delete next[key];
    } else if (isValidModel(value)) {
      next[key] = value;
    }
  }
  target.roleModels = Object.keys(next).length > 0 ? next : undefined;
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
