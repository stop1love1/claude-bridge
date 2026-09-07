
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

/**
 * Fold a fresh heuristic scan onto whatever the store already held, keeping an
 * LLM-written summary alive.
 *
 * The heuristic paths run behind the operator's back — `ensureFreshOrAuto`
 * fires on any `GET /api/repos/profiles` once the store is past
 * `PROFILE_TTL_MS`, and `POST /api/tasks` refreshes on task creation. Writing
 * the scan in as a whole object would drop `summarySource: "llm"` together
 * with the summary/features/entrypoints an operator paid an LLM pass for,
 * silently, roughly a day after every enrichment.
 *
 * Only the LLM-owned fields survive; `stack`, `keywords`, `fileCounts`,
 * `signals` and `refreshedAt` always come from the new scan, so a repo that
 * changed shape still reports the truth.
 *
 * Returns `next` **by identity** when it decides not to carry anything over,
 * so callers can tell "kept something" from "wrote the scan" without a second
 * comparison.
 */
function keepEnrichment(
  prev: RepoProfile | undefined,
  next: RepoProfile,
): RepoProfile {
  if (prev?.summarySource !== "llm") return next;
  // Enrichment describes one codebase, and the store is keyed by repo *name*.
  // Repoint an app at another directory in `bridge.json` and the name survives
  // while the code underneath does not, so an LLM summary carried across would
  // describe the old tree forever. Compared verbatim: a path that differs only
  // in separator or case reads as a move and costs one enrichment, which is
  // the safe direction to be wrong in.
  if (prev.path !== next.path) return next;
  // `loadProfiles` only validates the envelope, so an entry can be anything a
  // hand-edited `repo-profiles.json` contains. Spreading a missing array here
  // would throw inside a refresh that has no business failing.
  if (
    typeof prev.summary !== "string" ||
    !Array.isArray(prev.features) ||
    !Array.isArray(prev.entrypoints)
  ) {
    return next;
  }
  return {
    ...next,
    summary: prev.summary,
    features: [...prev.features],
    entrypoints: [...prev.entrypoints],
    summarySource: "llm",
  };
}

export function refreshAll(repos: RepoLike[]): ProfileStore {
  const store = loadProfiles() ?? emptyStore();
  for (const r of repos) {
    if (r.exists === false) continue;
    const profile = scanRepoIfExists(r.path);
    if (profile) {
      store.profiles[r.name] = keepEnrichment(store.profiles[r.name], profile);
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
    if (profile) {
      store.profiles[repo.name] = keepEnrichment(store.profiles[repo.name], profile);
    }
  }
  store.refreshedAt = new Date().toISOString();
  store.version = PROFILE_STORE_VERSION;
  saveProfiles(store);
  return store;
}

interface EnrichOutcome {
  profile: RepoProfile;
  /** The operator asked for an LLM pass (`profiles.source === "llm"`). */
  requested: boolean;
  /** The pass actually produced an LLM-written profile. */
  enriched: boolean;
}

/**
 * Enrichment gate. Returns the heuristic profile untouched unless the
 * operator opted into `profiles.source = "llm"`; a failing or slow CLI is
 * logged and swallowed, never propagated.
 *
 * The two flags exist because "here is your heuristic profile" is the answer
 * to two very different questions — *nobody asked for an LLM pass* and *the
 * LLM pass did not work* — and only the second one may not overwrite whatever
 * a previous pass already wrote. `summarizeWithLLM` swallows its own failures
 * and hands the input profile straight back, so the returned `summarySource`
 * is the only honest signal that the pass landed.
 */
async function enrich(profile: RepoProfile, deadline: number): Promise<EnrichOutcome> {
  if (getManifestProfileSource() !== "llm") {
    return { profile, requested: false, enriched: false };
  }
  if (Date.now() >= deadline) {
    logWarn("profile-store", "llm budget spent, keeping heuristic profile", {
      repo: profile.name,
    });
    return { profile, requested: true, enriched: false };
  }
  try {
    const out = await summarizeWithLLM(profile);
    return { profile: out, requested: true, enriched: out.summarySource === "llm" };
  } catch (err) {
    logWarn("profile-store", "llm summary failed (non-fatal)", {
      repo: profile.name,
      error: (err as Error).message,
    });
    return { profile, requested: true, enriched: false };
  }
}

/**
 * What goes into the store for one repo once the enrichment gate has run.
 *
 * An LLM pass that was asked for and did not land — missing CLI, 60s timeout,
 * spent budget, unusable response — must not cost the operator the summary an
 * earlier pass already paid for. Without this, turning `profiles.source` on
 * and hitting Refresh while the CLI is broken quietly wipes every enriched
 * profile in the store.
 *
 * When no pass was requested at all the fresh scan wins outright: switching
 * back to `heuristic` and refreshing is how an operator re-derives a profile
 * from scratch.
 */
function resolveEnriched(
  prev: RepoProfile | undefined,
  outcome: EnrichOutcome,
): RepoProfile {
  if (!outcome.requested || outcome.enriched) return outcome.profile;
  const kept = keepEnrichment(prev, outcome.profile);
  if (kept !== outcome.profile) {
    logWarn("profile-store", "llm pass produced nothing, keeping the previous summary", {
      repo: outcome.profile.name,
    });
  }
  return kept;
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
    store.profiles[r.name] = resolveEnriched(
      store.profiles[r.name],
      await enrich(profile, deadline),
    );
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
      store.profiles[repo.name] = resolveEnriched(
        store.profiles[repo.name],
        await enrich(profile, Date.now() + PROFILE_LLM_BUDGET_MS),
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
