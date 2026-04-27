/**
 * Bridge auth — single-user username/password login + signed session
 * cookie + a server-side trusted-device allowlist (revocable).
 *
 * Storage lives in `~/.claude/bridge.json` under the `auth` key (same
 * file as apps + telegram settings, so a `git pull` on the bridge
 * repo never touches credentials):
 *
 *   {
 *     "auth": {
 *       "username": "admin",
 *       "passwordHash": "scrypt$<N>$<r>$<p>$<saltB64>$<hashB64>",
 *       "secret": "<random 32B base64url>",            // HMAC signing key
 *       "internalToken": "<random 32B base64url>",     // child-agent bypass
 *       "trustedDevices": [
 *         { id, label?, createdAt, lastSeenAt, expiresAt }
 *       ]
 *     }
 *   }
 *
 * Cookie format (compact + edge-runtime friendly):
 *   <base64url(JSON payload)>.<base64url(HMAC-SHA256(secret, payload))>
 *
 * Payload: `{ sub, exp, did? }` — `did` = trusted-device id when the
 * operator ticked "Trust this device". The middleware re-checks `did`
 * against the allowlist on every request so revocation is instant.
 *
 * Two TTL classes:
 *   - "session" (untrusted device) — short cookie life, browser-session
 *     scoped if possible. Re-login required after restart.
 *   - "trusted" — 30-day cookie + matching trustedDevices entry. Operator
 *     can revoke per-device from `/settings`.
 */

import {
  randomBytes,
  scrypt as scryptCb,
  timingSafeEqual,
  createHmac,
} from "node:crypto";
import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { USER_CLAUDE_DIR } from "./paths";

const scrypt = promisify(scryptCb) as (
  password: string | Buffer,
  salt: Buffer,
  keylen: number,
) => Promise<Buffer>;

const BRIDGE_JSON = join(USER_CLAUDE_DIR, "bridge.json");

const SCRYPT_N = 16384;
const SCRYPT_r = 8;
const SCRYPT_p = 1;
const SCRYPT_KEYLEN = 64;
const SALT_BYTES = 16;

export const COOKIE_NAME = "bridge_session";
/** Default session TTL when "Trust this device" is OFF — 12 hours. */
export const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
/** Trusted-device TTL — 30 days. */
export const TRUSTED_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** Internal header child agents send so middleware can bypass auth. */
export const INTERNAL_TOKEN_HEADER = "x-bridge-internal-token";

// -----------------------------------------------------------------------------
// bridge.json IO (auth-section-aware, preserves all other top-level keys)
// -----------------------------------------------------------------------------

export interface TrustedDevice {
  id: string;
  label?: string;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
}

export interface AuthConfig {
  /** Operator email — used as the login identifier. */
  email: string;
  passwordHash: string;
  secret: string;
  internalToken: string;
  trustedDevices: TrustedDevice[];
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export function isValidEmail(s: string): boolean {
  return EMAIL_RE.test(s.trim());
}

interface RawManifest {
  version?: number;
  apps?: unknown;
  auth?: Partial<AuthConfig>;
  [k: string]: unknown;
}

function readManifest(): RawManifest {
  if (!existsSync(BRIDGE_JSON)) return { version: 1, apps: [] };
  try {
    return JSON.parse(readFileSync(BRIDGE_JSON, "utf8")) as RawManifest;
  } catch {
    return { version: 1, apps: [] };
  }
}

function atomicWrite(path: string, contents: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  writeFileSync(tmp, contents);
  try { renameSync(tmp, path); }
  catch (err) { try { unlinkSync(tmp); } catch { /* ignore */ } throw err; }
}

function writeManifest(m: RawManifest): void {
  // Re-order so "version" + "apps" come first, matches lib/apps.ts convention.
  const ordered = {
    version: typeof m.version === "number" ? m.version : 1,
    apps: Array.isArray(m.apps) ? m.apps : [],
    ...Object.fromEntries(Object.entries(m).filter(([k]) => k !== "version" && k !== "apps")),
  };
  atomicWrite(BRIDGE_JSON, JSON.stringify(ordered, null, 2) + "\n");
}

function normalizeAuth(raw: Partial<AuthConfig> | undefined): AuthConfig | null {
  if (!raw || typeof raw !== "object") return null;
  const email = typeof raw.email === "string" ? raw.email.trim() : "";
  const passwordHash = typeof raw.passwordHash === "string" ? raw.passwordHash.trim() : "";
  const secret = typeof raw.secret === "string" ? raw.secret.trim() : "";
  const internalToken = typeof raw.internalToken === "string" ? raw.internalToken.trim() : "";
  if (!email || !passwordHash || !secret) return null;
  const trustedDevices = Array.isArray(raw.trustedDevices)
    ? raw.trustedDevices.flatMap((d): TrustedDevice[] => {
        if (!d || typeof d !== "object") return [];
        const id = typeof d.id === "string" ? d.id : "";
        const createdAt = typeof d.createdAt === "string" ? d.createdAt : "";
        const lastSeenAt = typeof d.lastSeenAt === "string" ? d.lastSeenAt : "";
        const expiresAt = typeof d.expiresAt === "string" ? d.expiresAt : "";
        if (!id || !createdAt || !expiresAt) return [];
        const out: TrustedDevice = { id, createdAt, lastSeenAt: lastSeenAt || createdAt, expiresAt };
        if (typeof d.label === "string" && d.label.trim()) out.label = d.label.trim();
        return [out];
      })
    : [];
  return { email, passwordHash, secret, internalToken, trustedDevices };
}

export function loadAuthConfig(): AuthConfig | null {
  return normalizeAuth(readManifest().auth);
}

export function saveAuthConfig(next: AuthConfig): void {
  const m = readManifest();
  m.auth = next;
  writeManifest(m);
}

/** True when `auth` is configured (operator has set a password). */
export function isAuthConfigured(): boolean {
  return loadAuthConfig() !== null;
}

// -----------------------------------------------------------------------------
// Password hashing (scrypt, node-only)
// -----------------------------------------------------------------------------

export async function hashPassword(plain: string): Promise<string> {
  if (!plain || typeof plain !== "string") {
    throw new Error("password must be a non-empty string");
  }
  const salt = randomBytes(SALT_BYTES);
  const hash = await scrypt(plain, salt, SCRYPT_KEYLEN);
  return [
    "scrypt",
    String(SCRYPT_N),
    String(SCRYPT_r),
    String(SCRYPT_p),
    salt.toString("base64"),
    hash.toString("base64"),
  ].join("$");
}

export async function verifyPassword(plain: string, stored: string): Promise<boolean> {
  if (!plain || !stored) return false;
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const N = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (!Number.isFinite(N) || !Number.isFinite(r) || !Number.isFinite(p)) return false;
  let salt: Buffer; let expected: Buffer;
  try {
    salt = Buffer.from(parts[4], "base64");
    expected = Buffer.from(parts[5], "base64");
  } catch { return false; }
  // We always hash with the canonical params; older blobs would need a
  // bespoke `scrypt(..., {N,r,p})` call. For now if the params drift from
  // the canonical set we treat the hash as invalid — a re-set fixes it.
  if (N !== SCRYPT_N || r !== SCRYPT_r || p !== SCRYPT_p) return false;
  const actual = await scrypt(plain, salt, expected.length);
  if (actual.length !== expected.length) return false;
  return timingSafeEqual(actual, expected);
}

// -----------------------------------------------------------------------------
// Cookie sign/verify (HMAC-SHA256 via node:crypto — middleware uses
// `runtime: 'nodejs'` so we can share this code path)
// -----------------------------------------------------------------------------

export interface SessionPayload {
  /** Subject — username. */
  sub: string;
  /** Expiry epoch milliseconds. */
  exp: number;
  /** Trusted device id, set when "Trust this device" was checked. */
  did?: string;
}

function b64urlEncode(buf: Buffer): string {
  return buf.toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function b64urlDecode(str: string): Buffer {
  const pad = str.length % 4 === 0 ? "" : "=".repeat(4 - (str.length % 4));
  return Buffer.from(str.replace(/-/g, "+").replace(/_/g, "/") + pad, "base64");
}

export function signSession(payload: SessionPayload, secret: string): string {
  const body = b64urlEncode(Buffer.from(JSON.stringify(payload), "utf8"));
  const mac = b64urlEncode(createHmac("sha256", secret).update(body).digest());
  return `${body}.${mac}`;
}

/**
 * Verify a session token. Returns the payload on success, or null if
 * the signature is invalid, the token is malformed, or it has expired.
 *
 * Note: this only checks signature + expiry. Trusted-device revocation
 * is checked separately by the middleware, which compares `payload.did`
 * against the live `trustedDevices` allowlist on every request.
 */
export function verifySession(token: string, secret: string): SessionPayload | null {
  if (!token || typeof token !== "string") return null;
  const dot = token.indexOf(".");
  if (dot <= 0 || dot === token.length - 1) return null;
  const body = token.slice(0, dot);
  const mac = token.slice(dot + 1);
  let expectedMac: string;
  try {
    expectedMac = b64urlEncode(createHmac("sha256", secret).update(body).digest());
  } catch { return null; }
  // Constant-time compare — convert to equal-length buffers first.
  const a = Buffer.from(mac);
  const b = Buffer.from(expectedMac);
  if (a.length !== b.length) return null;
  if (!timingSafeEqual(a, b)) return null;
  let payload: SessionPayload;
  try {
    payload = JSON.parse(b64urlDecode(body).toString("utf8")) as SessionPayload;
  } catch { return null; }
  if (typeof payload.sub !== "string" || typeof payload.exp !== "number") return null;
  if (Date.now() >= payload.exp) return null;
  return payload;
}

// -----------------------------------------------------------------------------
// Trusted-device allowlist
// -----------------------------------------------------------------------------

export function addTrustedDevice(label: string | undefined): {
  cfg: AuthConfig;
  device: TrustedDevice;
} {
  const cfg = loadAuthConfig();
  if (!cfg) throw new Error("auth not configured");
  const now = new Date();
  const device: TrustedDevice = {
    id: `dev_${randomBytes(12).toString("hex")}`,
    createdAt: now.toISOString(),
    lastSeenAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + TRUSTED_TTL_MS).toISOString(),
  };
  if (label && label.trim()) device.label = label.trim().slice(0, 80);
  const next: AuthConfig = {
    ...cfg,
    trustedDevices: [...pruneExpired(cfg.trustedDevices), device],
  };
  saveAuthConfig(next);
  return { cfg: next, device };
}

export function findTrustedDevice(id: string): TrustedDevice | null {
  const cfg = loadAuthConfig();
  if (!cfg) return null;
  const now = Date.now();
  const dev = cfg.trustedDevices.find((d) => d.id === id);
  if (!dev) return null;
  if (Date.parse(dev.expiresAt) <= now) return null;
  return dev;
}

export function touchTrustedDevice(id: string): void {
  const cfg = loadAuthConfig();
  if (!cfg) return;
  const now = new Date();
  const idx = cfg.trustedDevices.findIndex((d) => d.id === id);
  if (idx < 0) return;
  // Avoid thrashing the file: only rewrite when lastSeenAt is more than
  // 5 minutes old, since middleware runs on every request.
  const last = Date.parse(cfg.trustedDevices[idx].lastSeenAt);
  if (Number.isFinite(last) && now.getTime() - last < 5 * 60 * 1000) return;
  const next: AuthConfig = {
    ...cfg,
    trustedDevices: cfg.trustedDevices.map((d, i) =>
      i === idx ? { ...d, lastSeenAt: now.toISOString() } : d,
    ),
  };
  saveAuthConfig(next);
}

export function revokeTrustedDevice(id: string): boolean {
  const cfg = loadAuthConfig();
  if (!cfg) return false;
  const next = cfg.trustedDevices.filter((d) => d.id !== id);
  if (next.length === cfg.trustedDevices.length) return false;
  saveAuthConfig({ ...cfg, trustedDevices: next });
  return true;
}

export function pruneExpired(list: TrustedDevice[]): TrustedDevice[] {
  const now = Date.now();
  return list.filter((d) => Date.parse(d.expiresAt) > now);
}

// -----------------------------------------------------------------------------
// First-time install helper (used by scripts/set-password.ts)
// -----------------------------------------------------------------------------

export async function setOperatorCredentials(
  emailOrUsername: string,
  plainPassword: string,
): Promise<AuthConfig> {
  const trimmed = (emailOrUsername || "").trim();
  if (!trimmed) throw new Error("email required");
  if (!isValidEmail(trimmed)) throw new Error("email format is invalid");
  if (!plainPassword || plainPassword.length < 8) {
    throw new Error("password must be at least 8 characters");
  }
  const passwordHash = await hashPassword(plainPassword);
  const existing = loadAuthConfig();
  const next: AuthConfig = {
    email: trimmed,
    passwordHash,
    secret: existing?.secret ?? b64urlEncode(randomBytes(32)),
    internalToken: existing?.internalToken ?? b64urlEncode(randomBytes(32)),
    trustedDevices: existing?.trustedDevices ?? [],
  };
  saveAuthConfig(next);
  return next;
}

/**
 * Verify a request is authenticated. Used by the routes under
 * `/api/auth/approvals` (which the proxy whitelists alongside the
 * rest of `/api/auth/`, so we have to gate them ourselves) and any
 * future endpoint that needs auth without going through the proxy
 * matcher.
 *
 * Returns the session payload on success, or null on any of:
 *   - auth not configured
 *   - cookie missing / invalid signature / expired
 *   - cookie carries a `did` for a trusted device that has been revoked
 */
export interface RequestLike {
  cookies: { get(name: string): { value: string } | undefined };
}
export function verifyRequestAuth(req: RequestLike): SessionPayload | null {
  const cfg = loadAuthConfig();
  if (!cfg) return null;
  const token = req.cookies.get(COOKIE_NAME)?.value;
  if (!token) return null;
  const payload = verifySession(token, cfg.secret);
  if (!payload) return null;
  // If the cookie is bound to a trusted-device id, it must still be
  // in the allowlist — same revocation-on-every-request semantic the
  // proxy uses.
  if (payload.did && !findTrustedDevice(payload.did)) return null;
  return payload;
}

/**
 * Read or generate the internal-bypass token. The bridge process injects
 * this into spawned-child env so the permission hook + coordinator self-
 * register calls can pass auth without a cookie. We auto-create on first
 * read so existing installs upgrade transparently — no migration script
 * required.
 */
export function getOrCreateInternalToken(): string {
  const existing = loadAuthConfig();
  if (existing && existing.internalToken) return existing.internalToken;
  if (!existing) {
    // Auth isn't configured yet (no password set). Return an empty
    // string — middleware also short-circuits when auth isn't set,
    // so children don't need to send anything.
    return "";
  }
  const internalToken = b64urlEncode(randomBytes(32));
  saveAuthConfig({ ...existing, internalToken });
  return internalToken;
}
