/**
 * P3a — on-disk cache for `SymbolIndex` per app.
 *
 * Layout: `<BRIDGE_STATE_DIR>/symbol-indexes.json`. Single JSON file
 * keyed by app name, mirroring `profileStore.ts` shape so the same
 * mental model applies. Refresh is on-demand:
 *
 *   - `ensureFreshSymbolIndex(appName, appPath, dirs)` — lazy entry
 *     point. Returns the cached index unless missing or older than
 *     `SYMBOL_TTL_MS`, in which case it triggers a re-scan.
 *   - `refreshSymbolIndex(appName, appPath, dirs)` — explicit force
 *     refresh, used when the operator clicks "rescan" in the UI (P3b).
 *
 * Failure to refresh (any error) is swallowed — the previous cached
 * index is returned, never block a caller on symbol-build.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BRIDGE_STATE_DIR } from "./paths";
import { scanSymbols, type SymbolIndex } from "./symbolIndex";

export const SYMBOL_STORE_VERSION = 1;
/** Lazy-refresh TTL — same 24h cadence as repo profiles. */
export const SYMBOL_TTL_MS = 24 * 60 * 60 * 1000;

export interface SymbolStore {
  version: number;
  refreshedAt: string;
  indexes: Record<string, SymbolIndex>;
}

function storeFilePath(): string {
  return join(BRIDGE_STATE_DIR, "symbol-indexes.json");
}

function ensureStateDir(): void {
  if (!existsSync(BRIDGE_STATE_DIR)) {
    mkdirSync(BRIDGE_STATE_DIR, { recursive: true });
  }
}

function emptyStore(): SymbolStore {
  return {
    version: SYMBOL_STORE_VERSION,
    refreshedAt: new Date().toISOString(),
    indexes: {},
  };
}

/**
 * In-memory cache of `loadSymbolStore()`. The store is read on EVERY
 * spawn (`ensureFreshSymbolIndex` + `ensureFreshStyleFingerprint` both
 * loadSymbolStore-equivalent the underlying file), and on a busy
 * dispatch flow that's a `readFileSync` + `JSON.parse` per spawn for
 * the same file. TTL keeps the cache short enough that an external
 * editor / refresh writes are visible quickly. Invalidated explicitly
 * on save so writes from this process see fresh data on the next read.
 *
 * HMR-safe via globalThis like the meta + git queues.
 */
const SYMBOL_CACHE_TTL_MS = 5_000;
const SG = globalThis as unknown as {
  __bridgeSymbolStoreCache?: { value: SymbolStore | null; expires: number };
};
function readCache(): SymbolStore | null | undefined {
  const c = SG.__bridgeSymbolStoreCache;
  if (!c) return undefined;
  if (c.expires < Date.now()) return undefined;
  return c.value;
}
function writeCache(value: SymbolStore | null): void {
  SG.__bridgeSymbolStoreCache = {
    value,
    expires: Date.now() + SYMBOL_CACHE_TTL_MS,
  };
}
function invalidateCache(): void {
  SG.__bridgeSymbolStoreCache = undefined;
}

export function loadSymbolStore(): SymbolStore | null {
  const cached = readCache();
  if (cached !== undefined) return cached;
  const path = storeFilePath();
  if (!existsSync(path)) {
    writeCache(null);
    return null;
  }
  try {
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw) as SymbolStore;
    if (!parsed || typeof parsed !== "object") {
      writeCache(null);
      return null;
    }
    if (typeof parsed.version !== "number") {
      writeCache(null);
      return null;
    }
    if (!parsed.indexes || typeof parsed.indexes !== "object") {
      writeCache(null);
      return null;
    }
    writeCache(parsed);
    return parsed;
  } catch {
    writeCache(null);
    return null;
  }
}

export function saveSymbolStore(store: SymbolStore): void {
  ensureStateDir();
  const path = storeFilePath();
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(store, null, 2), "utf8");
  try {
    renameSync(tmp, path);
  } catch (err) {
    // Windows can't rename over a locked file; fall back to delete+rename.
    try {
      if (existsSync(path)) unlinkSync(path);
      renameSync(tmp, path);
    } catch {
      throw err;
    }
  }
  // Drop the cache so the next loadSymbolStore in this process reads
  // the freshly-written file rather than the pre-write snapshot.
  invalidateCache();
}

export function getSymbolIndex(appName: string): SymbolIndex | null {
  const store = loadSymbolStore();
  if (!store) return null;
  return store.indexes[appName] ?? null;
}

/**
 * Force-refresh one app's index regardless of TTL. Used by an explicit
 * "rescan symbols" UI action; also internally by `ensureFreshSymbolIndex`
 * when the cache is stale.
 */
export function refreshSymbolIndex(
  appName: string,
  appPath: string,
  symbolDirs: string[] = [],
): SymbolIndex | null {
  if (!existsSync(appPath)) return null;
  const store = loadSymbolStore() ?? emptyStore();
  let fresh: SymbolIndex;
  try {
    fresh = scanSymbols(appPath, symbolDirs);
  } catch (err) {
    console.error(`symbolStore: scan failed for ${appName}`, err);
    return store.indexes[appName] ?? null;
  }
  store.indexes[appName] = fresh;
  store.refreshedAt = new Date().toISOString();
  store.version = SYMBOL_STORE_VERSION;
  saveSymbolStore(store);
  return fresh;
}

/**
 * Lazy entry point used by the spawn pipeline. Returns the cached
 * index unless missing or older than `SYMBOL_TTL_MS`, in which case
 * triggers a re-scan. Failure to refresh returns the stale entry
 * (or null when there's nothing cached at all).
 */
export function ensureFreshSymbolIndex(
  appName: string,
  appPath: string,
  symbolDirs: string[] = [],
): SymbolIndex | null {
  const store = loadSymbolStore();
  const existing = store?.indexes[appName] ?? null;
  const stale = (() => {
    if (!existing) return true;
    const age = Date.now() - new Date(existing.refreshedAt).getTime();
    return Number.isNaN(age) || age >= SYMBOL_TTL_MS;
  })();
  if (!stale) return existing;
  try {
    return refreshSymbolIndex(appName, appPath, symbolDirs);
  } catch (err) {
    console.error("ensureFreshSymbolIndex: refresh failed", err);
    return existing;
  }
}
