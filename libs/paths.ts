import { resolve, join, basename } from "node:path";
import { homedir } from "node:os";
import { readFileSync } from "node:fs";

export const BRIDGE_ROOT = resolve(/* turbopackIgnore: true */ process.cwd());
export const BRIDGE_FOLDER = basename(BRIDGE_ROOT);
export const BRIDGE_MD = join(BRIDGE_ROOT, "BRIDGE.md");

export function readBridgeMd(): string {
  try {
    return readFileSync(BRIDGE_MD, "utf8");
  } catch {
    return "";
  }
}
export const SESSIONS_DIR = join(BRIDGE_ROOT, "sessions");

export const BRIDGE_LOGIC_DIR = join(BRIDGE_ROOT, "prompts");

export const HOOKS_DIR = join(BRIDGE_ROOT, "agents");

export const BRIDGE_STATE_DIR = join(BRIDGE_ROOT, ".bridge-state");

export const CLAUDE_DIR = join(BRIDGE_ROOT, ".claude");

export const USER_CLAUDE_DIR = join(/* turbopackIgnore: true */ homedir(), ".claude");

export const DEFAULT_BRIDGE_PORT = 7777;

// The HTTP listener and every callback URL (BRIDGE_URL, the permission hook,
// tunnels, the process lock) must agree on one port, so both read this.
export function resolveBridgePort(
  env: Record<string, string | undefined> = process.env,
): number {
  return Number(env.BRIDGE_PORT ?? env.PORT ?? DEFAULT_BRIDGE_PORT);
}

export const BRIDGE_PORT = resolveBridgePort(process.env);

export const BRIDGE_URL = process.env.BRIDGE_URL ?? `http://localhost:${BRIDGE_PORT}`;

export function getPublicBridgeUrl(): string {
  const envExplicit = process.env.BRIDGE_PUBLIC_URL?.trim();
  if (envExplicit) return stripTrailingSlash(envExplicit);
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { getManifestPublicUrl } = require("./apps") as {
      getManifestPublicUrl: () => string;
    };
    const fromManifest = getManifestPublicUrl();
    if (fromManifest) return stripTrailingSlash(fromManifest);
  } catch {
  }
  if (process.env.BRIDGE_URL) return stripTrailingSlash(process.env.BRIDGE_URL);
  return stripTrailingSlash(BRIDGE_URL);
}

function stripTrailingSlash(s: string): string {
  return s.endsWith("/") ? s.slice(0, -1) : s;
}
