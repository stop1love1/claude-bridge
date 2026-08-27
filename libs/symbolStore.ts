import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { writeJsonAtomic } from "./atomicWrite";
import { BRIDGE_STATE_DIR } from "./paths";
import { scanSymbols, type SymbolIndex } from "./symbolIndex";

export const SYMBOL_STORE_VERSION = 1;
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
  writeJsonAtomic(storeFilePath(), store);
  invalidateCache();
}

export function getSymbolIndex(appName: string): SymbolIndex | null {
  const store = loadSymbolStore();
  if (!store) return null;
  return store.indexes[appName] ?? null;
}

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
