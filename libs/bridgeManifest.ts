/**
 * Single source of truth for `~/.claude/bridge.json` IO.
 *
 * Three modules touch this file: `auth.ts` (credentials + trusted
 * devices), `apps.ts` (apps registry + git settings), and `tunnels.ts`
 * (ngrok authtoken). Before this module they each invented their own
 * read/write helper, which had two problems:
 *
 *   1. Code duplication — three near-identical atomic-write paths.
 *   2. Cache desync — `auth.ts` cached `loadAuthConfig()` for 1s. When
 *      `tunnels.ts` wrote a fresh manifest the cache wasn't invalidated,
 *      so a subsequent `saveAuthConfig` could re-write a stale snapshot.
 *
 * Now every module reads + writes through here, sharing one cache and
 * one atomic-write path. Modules expose their own typed helpers
 * (`loadAuthConfig`, `getNgrokAuthtoken`, …) on top — the manifest
 * itself stays an open `Record<string, unknown>` so adding a future
 * top-level key (e.g. `runtime`, `experiments`) doesn't require
 * touching this file.
 */
import {
  existsSync,
  readFileSync,
} from "node:fs";
import { join } from "node:path";
import { writeStringAtomic } from "./atomicWrite";
import { USER_CLAUDE_DIR } from "./paths";

export const BRIDGE_JSON = join(USER_CLAUDE_DIR, "bridge.json");

export interface RawBridgeManifest {
  version?: number;
  apps?: unknown;
  auth?: unknown;
  tunnels?: unknown;
  runtime?: unknown;
  [k: string]: unknown;
}

const SCHEMA_VERSION = 1;
/**
 * proxy.ts calls loadAuthConfig() on every request. Without caching
 * that's a synchronous readFileSync per request. Cache for 1s; every
 * mutating write invalidates explicitly so the only stale window is
 * the TTL itself on read-only paths.
 */
const CACHE_TTL_MS = 1000;

let cache: { value: RawBridgeManifest; expires: number } | null = null;
const listeners: Array<() => void> = [];

function readRaw(): RawBridgeManifest {
  if (!existsSync(BRIDGE_JSON)) {
    return { version: SCHEMA_VERSION, apps: [] };
  }
  try {
    const parsed = JSON.parse(readFileSync(BRIDGE_JSON, "utf8")) as Partial<RawBridgeManifest>;
    return {
      version: typeof parsed.version === "number" ? parsed.version : SCHEMA_VERSION,
      apps: Array.isArray(parsed.apps) ? parsed.apps : [],
      ...Object.fromEntries(
        Object.entries(parsed).filter(([k]) => k !== "version" && k !== "apps"),
      ),
    };
  } catch {
    return { version: SCHEMA_VERSION, apps: [] };
  }
}

/**
 * Read with TTL cache. Cache invalidates on every write so the only
 * stale window is reads racing other reads — fine for read-only paths.
 * Mutating callers should always read fresh: pass `{ fresh: true }`
 * (or use `updateBridgeManifest`) to bypass the cache.
 */
export function readBridgeManifest(opts?: { fresh?: boolean }): RawBridgeManifest {
  if (opts?.fresh) {
    invalidateBridgeManifestCache();
    return readRaw();
  }
  const now = Date.now();
  if (cache && cache.expires > now) return cache.value;
  const value = readRaw();
  cache = { value, expires: now + CACHE_TTL_MS };
  return value;
}

export function invalidateBridgeManifestCache(): void {
  cache = null;
}

/**
 * Subscribe to write notifications. Used by `auth.ts` to drop its own
 * `authCache` whenever `tunnels.ts` or `apps.ts` rewrites the file —
 * keeps the per-module derived caches in sync without each module
 * having to know about the others.
 */
export function onBridgeManifestWrite(fn: () => void): void {
  listeners.push(fn);
}

function atomicWrite(contents: string): void {
  // mode: 0o600 — bridge.json holds password hashes, the HMAC secret,
  // the internal-bypass token, and the ngrok authtoken. POSIX users
  // colocated on a multi-tenant box must not be able to `cat` it.
  // Windows ignores the mode bit; the helper applies it pre- and
  // post-rename to defeat macOS variants that preserve the
  // destination inode's metadata across rename.
  writeStringAtomic(BRIDGE_JSON, contents, { mode: 0o600 });
}

/**
 * Atomic write. Re-orders so `version` and `apps` come first (matches
 * the on-disk convention prior modules established) then preserves
 * everything else verbatim. Invalidates cache + notifies subscribers.
 */
export function writeBridgeManifest(manifest: RawBridgeManifest): void {
  const ordered: RawBridgeManifest = {
    version: typeof manifest.version === "number" ? manifest.version : SCHEMA_VERSION,
    apps: Array.isArray(manifest.apps) ? manifest.apps : [],
    ...Object.fromEntries(
      Object.entries(manifest).filter(([k]) => k !== "version" && k !== "apps"),
    ),
  };
  atomicWrite(JSON.stringify(ordered, null, 2) + "\n");
  invalidateBridgeManifestCache();
  for (const fn of listeners) {
    try { fn(); } catch { /* per-listener failure mustn't stop others */ }
  }
}

/**
 * Read-modify-write helper. Bypasses the read cache (always reads
 * fresh from disk) so the updater can't be handed a stale snapshot.
 * The whole sequence is synchronous, so within a single Node process
 * concurrent callers serialize naturally on the event loop — no
 * explicit lock required.
 *
 * Pass an updater that returns the next manifest directly. For a
 * value-returning update, use `updateBridgeManifestWith` instead.
 */
export function updateBridgeManifest(
  updater: (m: RawBridgeManifest) => RawBridgeManifest,
): void {
  invalidateBridgeManifestCache();
  const fresh = readRaw();
  writeBridgeManifest(updater(fresh));
}

/**
 * Like `updateBridgeManifest` but the updater returns `{ manifest, result }`
 * so the caller can capture a value derived from the read-modify-write
 * (e.g. the freshly-generated trusted-device id).
 */
export function updateBridgeManifestWith<T>(
  updater: (m: RawBridgeManifest) => { manifest: RawBridgeManifest; result: T },
): T {
  invalidateBridgeManifestCache();
  const fresh = readRaw();
  const { manifest, result } = updater(fresh);
  writeBridgeManifest(manifest);
  return result;
}
