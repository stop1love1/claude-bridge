/**
 * Phase G — on-disk cache for `RepoProfile`s.
 *
 * Layout: `<BRIDGE_STATE_DIR>/repo-profiles.json` (already gitignored
 * via `.bridge-state/` in .gitignore). Single file holding a versioned
 * record keyed by repo folder name. Refresh is on-demand:
 *   - `ensureFreshOrAuto` is the lazy entrypoint (auto-builds on first
 *     hit, refreshes if older than 24h).
 *   - `refreshAll` / `refreshOne` are explicit force-refresh paths.
 * No background timer; staleness is bounded by usage.
 */

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { writeJsonAtomic } from "./atomicWrite";
import { BRIDGE_STATE_DIR } from "./paths";
import { scanRepoIfExists, type RepoProfile } from "./repoProfile";

export const PROFILE_STORE_VERSION = 1;
export const PROFILE_TTL_MS = 24 * 60 * 60 * 1000; // 24h

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
  // writeJsonAtomic handles mkdir + unique tmp suffix (so concurrent
  // writers can't trample the same `.tmp` staging) + cleanup on
  // rename failure. The legacy ad-hoc helper here used a shared
  // `${path}.tmp` suffix which raced under load.
  writeJsonAtomic(profileFilePath(), store);
}

/**
 * Re-scan every repo from `repos` whose folder exists, merging the
 * fresh profile into the store. Repos absent from disk are LEFT in the
 * cache as-is (so a temporarily missing sibling doesn't blow away its
 * last known profile). Saves and returns the new store.
 */
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

export function getProfile(name: string): RepoProfile | null {
  const store = loadProfiles();
  if (!store) return null;
  return store.profiles[name] ?? null;
}

/**
 * Lazy entrypoint. Returns the cached store unless it's missing or
 * older than `PROFILE_TTL_MS`, in which case it triggers a refresh.
 *
 * Failure to refresh (any error) is swallowed and the stale store is
 * returned — never block a caller on profile-build.
 */
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
    console.error("ensureFreshOrAuto: refresh failed", err);
    return store ?? emptyStore();
  }
}

export function profileStoreExists(): boolean {
  return existsSync(profileFilePath());
}
