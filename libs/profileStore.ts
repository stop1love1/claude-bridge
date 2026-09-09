
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { writeJsonAtomic } from "./atomicWrite";
import { BRIDGE_STATE_DIR } from "./paths";
import { scanRepoIfExists, type RepoProfile } from "./repoProfile";
import { summarizeWithLLM } from "./repoProfileLlm";
import { getManifestProfileSource, type ProfileManifestSource } from "./bridgeSettings";
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
    // Carried with the summary it dates. Dropping it here would leave an
    // enriched profile whose only timestamp is the heuristic re-scan.
    enrichedAt: prev.enrichedAt ?? null,
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
  /**
   * What the gate did.
   *
   * `not-requested` — `profiles.source` is `heuristic`; nobody asked.
   * `enriched`      — the pass ran and produced a new LLM summary.
   * `unchanged`     — the pass ran and had nothing to add to the heuristic.
   * `failed`        — the pass could not run, or answered unusably.
   *
   * `unchanged` used to be folded into `failed` because `summarizeWithLLM`
   * handed back a bare profile either way. It matters: a quiet-but-working
   * pass is evidence the enrichment is current, and should refresh its age.
   */
  status: "not-requested" | "enriched" | "unchanged" | "failed";
}

/**
 * Enrichment gate. Returns the heuristic profile untouched unless the
 * operator opted into `profiles.source = "llm"`; a failing or slow CLI is
 * logged and swallowed, never propagated.
 *
 * `source` is passed in rather than read here: a refresh reads
 * `profiles.source` once at the top and holds it for the whole pass. Reading
 * it per repo let an operator flipping the Settings toggle mid-refresh — five
 * minutes is a long time to hold still — turn the remaining repos into
 * "nobody asked", which writes their fresh heuristic scan straight over an
 * enrichment. Half a refresh under each setting is not a state anyone asked
 * for.
 */
async function enrich(
  profile: RepoProfile,
  deadline: number,
  source: ProfileManifestSource,
): Promise<EnrichOutcome> {
  if (source !== "llm") {
    return { profile, status: "not-requested" };
  }
  if (Date.now() >= deadline) {
    logWarn("profile-store", "llm budget spent, keeping heuristic profile", {
      repo: profile.name,
    });
    return { profile, status: "failed" };
  }
  try {
    const out = await summarizeWithLLM(profile);
    return { profile: out.profile, status: out.status };
  } catch (err) {
    logWarn("profile-store", "llm summary failed (non-fatal)", {
      repo: profile.name,
      error: (err as Error).message,
    });
    return { profile, status: "failed" };
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
/**
 * `enrichedAt` only means something on a profile whose summary actually came
 * from the model, so a pass that agreed with the heuristic on a repo that was
 * never enriched leaves no timestamp behind.
 */
function stampEnrichedAt(p: RepoProfile, at: string): RepoProfile {
  return p.summarySource === "llm" ? { ...p, enrichedAt: at } : p;
}

function resolveEnriched(
  prev: RepoProfile | undefined,
  outcome: EnrichOutcome,
  now: string,
): RepoProfile {
  if (outcome.status === "not-requested") return outcome.profile;
  if (outcome.status === "enriched") return stampEnrichedAt(outcome.profile, now);

  const kept = keepEnrichment(prev, outcome.profile);
  if (outcome.status === "unchanged") {
    // The CLI ran and confirmed what we already had — the enrichment is as
    // current as it can be, even though not a byte of it changed.
    return stampEnrichedAt(kept, now);
  }
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
/**
 * The refresh currently in flight, if any.
 *
 * Module-level rather than `globalThis`-backed on purpose: the tests re-import
 * this module per case (`vi.resetModules()`), so a module-level binding resets
 * itself and no `_resetForTests` hook is needed. In the server it is a single
 * long-lived module, which is exactly the scope the guard wants.
 */
let inFlightRefreshAll: Promise<ProfileStore> | null = null;

/**
 * Rebuild every profile, optionally through the LLM.
 *
 * Concurrent calls share one pass instead of racing. The window is real now
 * that Settings has a "Refresh now" button: each call loads the store, awaits
 * for up to five minutes, then writes the whole thing back, so two overlapping
 * refreshes end with the slower one silently discarding everything the faster
 * one enriched. Sharing rather than rejecting because the failure mode this
 * fixes is a double-click, and a second click should mean "yes, that one".
 */
export async function refreshAllEnriched(repos: RepoLike[]): Promise<ProfileStore> {
  if (inFlightRefreshAll) return inFlightRefreshAll;
  const pass = (async () => {
    const store = loadProfiles() ?? emptyStore();
    const deadline = Date.now() + PROFILE_LLM_BUDGET_MS;
    const source = getManifestProfileSource();
    for (const r of repos) {
      if (r.exists === false) continue;
      const profile = scanRepoIfExists(r.path);
      if (!profile) continue;
      store.profiles[r.name] = resolveEnriched(
        store.profiles[r.name],
        await enrich(profile, deadline, source),
        new Date().toISOString(),
      );
    }
    store.refreshedAt = new Date().toISOString();
    store.version = PROFILE_STORE_VERSION;
    saveProfiles(store);
    return store;
  })();
  inFlightRefreshAll = pass;
  try {
    return await pass;
  } finally {
    inFlightRefreshAll = null;
  }
}

export async function refreshOneEnriched(repo: RepoLike): Promise<ProfileStore> {
  const store = loadProfiles() ?? emptyStore();
  if (repo.exists !== false) {
    const profile = scanRepoIfExists(repo.path);
    if (profile) {
      store.profiles[repo.name] = resolveEnriched(
        store.profiles[repo.name],
        await enrich(
          profile,
          Date.now() + PROFILE_LLM_BUDGET_MS,
          getManifestProfileSource(),
        ),
        new Date().toISOString(),
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
