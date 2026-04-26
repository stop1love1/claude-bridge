/**
 * P3a / A1 — on-disk cache for `StyleFingerprint` per app.
 *
 * Same shape as `symbolStore.ts` and `profileStore.ts`: single JSON
 * file under `.bridge-state/`, one record per app keyed by name,
 * versioned, with a 24h lazy TTL refresh.
 *
 * Pure mirror of `symbolStore` — see that module's comments for the
 * rationale on TTL, fail-soft, and Windows rename fallback.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
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

export function loadStyleStore(): StyleStore | null {
  const path = storeFilePath();
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw) as StyleStore;
    if (!parsed || typeof parsed !== "object") return null;
    if (typeof parsed.version !== "number") return null;
    if (!parsed.fingerprints || typeof parsed.fingerprints !== "object") return null;
    return parsed;
  } catch {
    return null;
  }
}

export function saveStyleStore(store: StyleStore): void {
  ensureStateDir();
  const path = storeFilePath();
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(store, null, 2), "utf8");
  try {
    renameSync(tmp, path);
  } catch (err) {
    try {
      if (existsSync(path)) unlinkSync(path);
      renameSync(tmp, path);
    } catch {
      throw err;
    }
  }
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
