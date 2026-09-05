
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { writeJsonAtomic } from "./atomicWrite";
import { BRIDGE_STATE_DIR } from "./paths";
import { scanRepoIfExists, type RepoProfile } from "./repoProfile";
import { summarizeWithLLM } from "./repoProfileLlm";
import { getManifestProfileSource } from "./bridgeSettings";
import { logError, logWarn } from "./log";

export const PROFILE_STORE_VERSION = 1;
export const PROFILE_TTL_MS = 24 * 60 * 60 * 1000;
/**
 * Wall-clock ceiling for the LLM pass over a whole refresh. Enrichment runs
 * one repo at a time (never fanned out); once the budget is spent the
 * remaining repos keep their heuristic profile.
 */
export const PROFILE_LLM_BUDGET_MS = 5 * 60 * 1000;

export interface ProfileStore {
  version: number;
  refreshedAt: string;
  profiles: Record<string, RepoProfile>;
}

export interface RepoLike {
  name: string;
  path: string;
  exists?: boolean;
}

function profileFilePath(): string {
  return join(BRIDGE_STATE_DIR, "repo-profiles.json");
}

function ensureStateDir(): void {
  if (!existsSync(BRIDGE_STATE_DIR)) {
    mkdirSync(BRIDGE_STATE_DIR, { recursive: true });
  }
}

function emptyStore(): ProfileStore {
  return {
    version: PROFILE_STORE_VERSION,
    refreshedAt: new Date().toISOString(),
    profiles: {},
  };
}

export function loadProfiles(): ProfileStore | null {
  const path = profileFilePath();
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw) as ProfileStore;
    if (!parsed || typeof parsed !== "object") return null;
    if (typeof parsed.version !== "number") return null;
    if (!parsed.profiles || typeof parsed.profiles !== "object") return null;
    return parsed;
  } catch {
    return null;
  }
}

export function saveProfiles(store: ProfileStore): void {
  ensureStateDir();
  writeJsonAtomic(profileFilePath(), store);
}

export function refreshAll(repos: RepoLike[]): ProfileStore {
  const store = loadProfiles() ?? emptyStore();
  for (const r of repos) {
    if (r.exists === false) continue;
    const profile = scanRepoIfExists(r.path);
    if (profile) {
      store.profiles[r.name] = profile;
    }
  }
  store.refreshedAt = new Date().toISOString();
  store.version = PROFILE_STORE_VERSION;
  saveProfiles(store);
  return store;
}

export function refreshOne(repo: RepoLike): ProfileStore {
  const store = loadProfiles() ?? emptyStore();
  if (repo.exists !== false) {
    const profile = scanRepoIfExists(repo.path);
    if (profile) store.profiles[repo.name] = profile;
  }
  store.refreshedAt = new Date().toISOString();
  store.version = PROFILE_STORE_VERSION;
  saveProfiles(store);
  return store;
}

/**
 * Enrichment gate. Returns the heuristic profile untouched unless the
 * operator opted into `profiles.source = "llm"`; a failing or slow CLI is
 * logged and swallowed, never propagated.
 */
async function enrich(profile: RepoProfile, deadline: number): Promise<RepoProfile> {
  if (getManifestProfileSource() !== "llm") return profile;
  if (Date.now() >= deadline) {
    logWarn("profile-store", "llm budget spent, keeping heuristic profile", {
      repo: profile.name,
    });
    return profile;
  }
  try {
    return await summarizeWithLLM(profile);
  } catch (err) {
    logWarn("profile-store", "llm summary failed (non-fatal)", {
      repo: profile.name,
      error: (err as Error).message,
    });
    return profile;
  }
}

/**
 * `refreshAll` plus the optional LLM pass. Used by the operator-triggered
 * refresh endpoint; the synchronous `refreshAll` stays the fast path for
 * auto-init and TTL refreshes.
 */
export async function refreshAllEnriched(repos: RepoLike[]): Promise<ProfileStore> {
  const store = loadProfiles() ?? emptyStore();
  const deadline = Date.now() + PROFILE_LLM_BUDGET_MS;
  for (const r of repos) {
    if (r.exists === false) continue;
    const profile = scanRepoIfExists(r.path);
    if (!profile) continue;
    store.profiles[r.name] = await enrich(profile, deadline);
  }
  store.refreshedAt = new Date().toISOString();
  store.version = PROFILE_STORE_VERSION;
  saveProfiles(store);
  return store;
}

export async function refreshOneEnriched(repo: RepoLike): Promise<ProfileStore> {
  const store = loadProfiles() ?? emptyStore();
  if (repo.exists !== false) {
    const profile = scanRepoIfExists(repo.path);
    if (profile) {
      store.profiles[repo.name] = await enrich(
        profile,
        Date.now() + PROFILE_LLM_BUDGET_MS,
      );
    }
  }
  store.refreshedAt = new Date().toISOString();
  store.version = PROFILE_STORE_VERSION;
  saveProfiles(store);
  return store;
}

export function getProfile(name: string): RepoProfile | null {
  const store = loadProfiles();
  if (!store) return null;
  return store.profiles[name] ?? null;
}

export function ensureFreshOrAuto(repos: RepoLike[]): ProfileStore {
  const store = loadProfiles();
  const ttl = PROFILE_TTL_MS;
  const stale = (() => {
    if (!store) return true;
    const age = Date.now() - new Date(store.refreshedAt).getTime();
    return Number.isNaN(age) || age >= ttl;
  })();
  if (!stale && store) return store;
  try {
    return refreshAll(repos);
  } catch (err) {
    logError("profile-store", "ensureFreshOrAuto: refresh failed", err);
    return store ?? emptyStore();
  }
}

export function profileStoreExists(): boolean {
  return existsSync(profileFilePath());
}
