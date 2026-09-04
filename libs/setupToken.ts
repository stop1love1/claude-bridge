import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { BRIDGE_STATE_DIR } from "./paths";
import { logWarn } from "./log";

const SETUP_TOKEN_FILE = join(BRIDGE_STATE_DIR, "setup-token");

function b64urlEncode(buf: Buffer): string {
  return buf
    .toString("base64")
    .replace(/=+$/, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

export function ensureSetupToken(): string {
  try {
    mkdirSync(dirname(SETUP_TOKEN_FILE), { recursive: true });
  } catch {
  }
  if (existsSync(SETUP_TOKEN_FILE)) {
    try {
      const cached = readFileSync(SETUP_TOKEN_FILE, "utf8").trim();
      if (cached) return cached;
    } catch {
    }
  }
  const token = b64urlEncode(randomBytes(32));
  writeFileSync(SETUP_TOKEN_FILE, token + "\n");
  if (process.platform !== "win32") {
    try {
      chmodSync(SETUP_TOKEN_FILE, 0o600);
    } catch {
    }
  }
  return token;
}

export function verifySetupToken(provided: unknown): boolean {
  if (typeof provided !== "string" || !provided) return false;
  if (!existsSync(SETUP_TOKEN_FILE)) return false;
  let stored: string;
  try {
    stored = readFileSync(SETUP_TOKEN_FILE, "utf8").trim();
  } catch {
    return false;
  }
  if (!stored) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(stored);
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

export function clearSetupToken(): void {
  try {
    if (existsSync(SETUP_TOKEN_FILE)) unlinkSync(SETUP_TOKEN_FILE);
  } catch (err) {
    logWarn("setup-token", "failed to clear setup token (non-fatal)", { error: (err as Error)?.message ?? String(err) });
  }
}

export function hasSetupToken(): boolean {
  return existsSync(SETUP_TOKEN_FILE);
}

export const SETUP_TOKEN_PATH = SETUP_TOKEN_FILE;
