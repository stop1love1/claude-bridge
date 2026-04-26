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

export function loadSymbolStore(): SymbolStore | null {
  const path = storeFilePath();
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw) as SymbolStore;
    if (!parsed || typeof parsed !== "object") return null;
    if (typeof parsed.version !== "number") return null;
    if (!parsed.indexes || typeof parsed.indexes !== "object") return null;
    return parsed;
  } catch {
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
