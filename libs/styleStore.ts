/**
 * P3a / A1 — on-disk cache for `StyleFingerprint` per app.
 *
 * Same shape as `symbolStore.ts` and `profileStore.ts`: single JSON
 * file under `.bridge-state/`, one record per app keyed by name,
 * versioned, with a 24h lazy TTL refresh.
 *
 * Pure mirror of `symbolStore` — see that module's comments for the
 * rationale on TTL and fail-soft behavior.
 */
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { writeJsonAtomic } from "./atomicWrite";
import { BRIDGE_STATE_DIR } from "./paths";
import { scanStyle, type StyleFingerprint } from "./styleFingerprint";

export const STYLE_STORE_VERSION = 1;
export const STYLE_TTL_MS = 24 * 60 * 60 * 1000; // 24h

export interface StyleStore {
  version: number;
  refreshedAt: string;
  fingerprints: Record<string, StyleFingerprint>;
}

function storeFilePath(): string {
  return join(BRIDGE_STATE_DIR, "style-fingerprints.json");
}

function ensureStateDir(): void {
  if (!existsSync(BRIDGE_STATE_DIR)) {
    mkdirSync(BRIDGE_STATE_DIR, { recursive: true });
  }
}

function emptyStore(): StyleStore {
  return {
    version: STYLE_STORE_VERSION,
    refreshedAt: new Date().toISOString(),
    fingerprints: {},
  };
}

// Same in-memory cache pattern as symbolStore — see that module for
// rationale. Hot path: `ensureFreshStyleFingerprint` is called per
// spawn alongside symbol-index lookup; without this cache we paid
// for two redundant readFileSync + JSON.parse on every dispatch.
const STYLE_CACHE_TTL_MS = 5_000;
const SG = globalThis as unknown as {
  __bridgeStyleStoreCache?: { value: StyleStore | null; expires: number };
};
function readCache(): StyleStore | null | undefined {
  const c = SG.__bridgeStyleStoreCache;
  if (!c) return undefined;
  if (c.expires < Date.now()) return undefined;
  return c.value;
}
function writeCache(value: StyleStore | null): void {
  SG.__bridgeStyleStoreCache = {
    value,
    expires: Date.now() + STYLE_CACHE_TTL_MS,
  };
}
function invalidateCache(): void {
  SG.__bridgeStyleStoreCache = undefined;
}

export function loadStyleStore(): StyleStore | null {
  const cached = readCache();
  if (cached !== undefined) return cached;
  const path = storeFilePath();
  if (!existsSync(path)) {
    writeCache(null);
    return null;
  }
  try {
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw) as StyleStore;
    if (!parsed || typeof parsed !== "object") { writeCache(null); return null; }
    if (typeof parsed.version !== "number") { writeCache(null); return null; }
    if (!parsed.fingerprints || typeof parsed.fingerprints !== "object") {
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

export function saveStyleStore(store: StyleStore): void {
  ensureStateDir();
  // Shared atomic-write helper with unique tmp suffix — see
  // libs/atomicWrite.ts. The legacy `${path}.tmp` shared suffix raced
  // when two style refreshes ran concurrently for different apps.
  writeJsonAtomic(storeFilePath(), store);
  invalidateCache();
}

export function getStyleFingerprint(appName: string): StyleFingerprint | null {
  const store = loadStyleStore();
  if (!store) return null;
  return store.fingerprints[appName] ?? null;
}

export function refreshStyleFingerprint(
  appName: string,
  appPath: string,
): StyleFingerprint | null {
  if (!existsSync(appPath)) return null;
  const store = loadStyleStore() ?? emptyStore();
  let fresh: StyleFingerprint;
  try {
    fresh = scanStyle(appPath);
  } catch (err) {
    console.error(`styleStore: scan failed for ${appName}`, err);
    return store.fingerprints[appName] ?? null;
  }
  store.fingerprints[appName] = fresh;
  store.refreshedAt = new Date().toISOString();
  store.version = STYLE_STORE_VERSION;
  saveStyleStore(store);
  return fresh;
}

export function ensureFreshStyleFingerprint(
  appName: string,
  appPath: string,
): StyleFingerprint | null {
  const store = loadStyleStore();
  const existing = store?.fingerprints[appName] ?? null;
  const stale = (() => {
    if (!existing) return true;
    const age = Date.now() - new Date(existing.refreshedAt).getTime();
    return Number.isNaN(age) || age >= STYLE_TTL_MS;
  })();
  if (!stale) return existing;
  try {
    return refreshStyleFingerprint(appName, appPath);
  } catch (err) {
    console.error("ensureFreshStyleFingerprint: refresh failed", err);
    return existing;
  }
}
