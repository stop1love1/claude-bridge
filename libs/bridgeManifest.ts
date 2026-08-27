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

export function onBridgeManifestWrite(fn: () => void): void {
  listeners.push(fn);
}

function atomicWrite(contents: string): void {
  writeStringAtomic(BRIDGE_JSON, contents, { mode: 0o600 });
}

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
    try { fn(); } catch { }
  }
}

export function updateBridgeManifest(
  updater: (m: RawBridgeManifest) => RawBridgeManifest,
): void {
  invalidateBridgeManifestCache();
  const fresh = readRaw();
  writeBridgeManifest(updater(fresh));
}

export function updateBridgeManifestWith<T>(
  updater: (m: RawBridgeManifest) => { manifest: RawBridgeManifest; result: T },
): T {
  invalidateBridgeManifestCache();
  const fresh = readRaw();
  const { manifest, result } = updater(fresh);
  writeBridgeManifest(manifest);
  return result;
}
