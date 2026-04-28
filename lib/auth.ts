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
import { promisify } from "node:util";
import {
  onBridgeManifestWrite,
  readBridgeManifest,
  updateBridgeManifest,
} from "./bridgeManifest";

interface ScryptOpts {
  N?: number;
  r?: number;
  p?: number;
  maxmem?: number;
}
const scrypt = promisify(scryptCb) as (
  password: string | Buffer,
  salt: Buffer,
  keylen: number,
  opts?: ScryptOpts,
) => Promise<Buffer>;

// Tightened from N=16384 to N=131072 (2^17) — matches OWASP 2024+
// recommendation for server-side scrypt. ~150ms verify on a modern
// laptop, ~10x harder to bruteforce a leaked hash. Backward compat is
// preserved: `verifyPassword` parses N/r/p from the stored hash, so
// pre-existing 16384 hashes keep working until the operator next runs
// `set-password` (which always re-hashes with the current params).
const SCRYPT_N = 131072;
const SCRYPT_r = 8;
const SCRYPT_p = 1;
const SCRYPT_KEYLEN = 64;
const SALT_BYTES = 16;
/** Sane upper bound on stored N to refuse pathological hashes. */
const SCRYPT_MAX_N = 1 << 20;

/** Lower-bound for any new password set via the bridge UI / CLI. */
export const MIN_PASSWORD_LENGTH = 12;

export const COOKIE_NAME = "bridge_session";
/** Default session TTL when "Trust this device" is OFF — 12 hours. */
export const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
/** Trusted-device TTL — 30 days. */
export const TRUSTED_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** Internal header child agents send so middleware can bypass auth. */
export const INTERNAL_TOKEN_HEADER = "x-bridge-internal-token";

/**
 * Centralized cookie attribute set so every auth route — login, setup,
 * pending-approval, logout — agrees on flags. `secure` flips on under
 * `NODE_ENV === "production"` because the bridge is now meant to be
 * runnable behind a public TLS terminator (`.env.production` shows the
 * deployed `claude.stop1love1.online` origin), not just localhost. Dev
 * stays insecure-cookie OK because `next dev` listens on plain HTTP.
 *
 * Caller passes `maxAgeMs` (or 0 for an immediate clear). `path: "/"`
 * + `httpOnly: true` + `sameSite: "lax"` are constants — every cookie
 * the bridge issues uses the same path so logout reliably clears
 * whatever was set by login / setup / pending-approval.
 */
export function sessionCookieOptions(maxAgeMs: number): {
  httpOnly: true;
  sameSite: "lax";
  secure: boolean;
  path: "/";
  maxAge: number;
} {
  return {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: Math.floor(maxAgeMs / 1000),
  };
}

// -----------------------------------------------------------------------------
// auth section (atop the shared bridge.json IO in ./bridgeManifest)
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

// Short-lived derived cache for loadAuthConfig(). Distinct from the
// raw-manifest cache in bridgeManifest.ts because the normalize step
// (validating shape, projecting trustedDevices) is non-trivial. Drop
// it whenever ANY module rewrites bridge.json — apps.ts changing git
// settings shouldn't force loadAuthConfig() to re-normalize, but it
// also can't be allowed to serve a stale auth payload after a tunnels
// authtoken save (which goes through a different path).
const AUTH_CACHE_TTL_MS = 1000;
let authCache: { value: AuthConfig | null; expires: number } | null = null;
onBridgeManifestWrite(() => { authCache = null; });

function normalizeAuth(raw: unknown): AuthConfig | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Partial<AuthConfig>;
  const email = typeof r.email === "string" ? r.email.trim() : "";
  const passwordHash = typeof r.passwordHash === "string" ? r.passwordHash.trim() : "";
  const secret = typeof r.secret === "string" ? r.secret.trim() : "";
  const internalToken = typeof r.internalToken === "string" ? r.internalToken.trim() : "";
  if (!email || !passwordHash || !secret) return null;
  const trustedDevices = Array.isArray(r.trustedDevices)
    ? r.trustedDevices.flatMap((d): TrustedDevice[] => {
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
  const now = Date.now();
  if (authCache && authCache.expires > now) return authCache.value;
  const value = normalizeAuth(readBridgeManifest().auth);
  authCache = { value, expires: now + AUTH_CACHE_TTL_MS };
  return value;
}

export function saveAuthConfig(next: AuthConfig): void {
  updateBridgeManifest((m) => ({ ...m, auth: next as unknown }));
  // onBridgeManifestWrite already nuked authCache; nothing else to do.
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
  // Match the maxmem we use for verifyPassword so N=131072 doesn't trip
  // Node's default 32 MiB ceiling.
  const maxmem = 256 * SCRYPT_N * SCRYPT_r;
  const hash = await scrypt(plain, salt, SCRYPT_KEYLEN, {
    N: SCRYPT_N,
    r: SCRYPT_r,
    p: SCRYPT_p,
    maxmem,
  });
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
  if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p)) return false;
  // Refuse pathological / hostile params: a leaked bridge.json that's
  // been tampered with shouldn't be able to coerce us into a multi-
  // gigabyte scrypt call. Lower bound mirrors the historical N=16384.
  if (N < 16384 || N > SCRYPT_MAX_N || r < 1 || r > 32 || p < 1 || p > 16) return false;
  // N must be a power of two — required by the scrypt spec.
  if ((N & (N - 1)) !== 0) return false;
  let salt: Buffer; let expected: Buffer;
  try {
    salt = Buffer.from(parts[4], "base64");
    expected = Buffer.from(parts[5], "base64");
  } catch { return false; }
  // Use the params from the stored hash — this is what makes the
  // SCRYPT_N bump backward-compatible. Older 16384 hashes still
  // verify; a future `set-password` call rolls them forward to the
  // current SCRYPT_N. Pass `maxmem` because Node enforces a default
  // 32 MiB ceiling that N=131072 (~128 MiB) blows past.
  const maxmem = 256 * N * r;
  const actual = await scrypt(plain, salt, expected.length, { N, r, p, maxmem });
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
  if (!plainPassword || plainPassword.length < MIN_PASSWORD_LENGTH) {
    throw new Error(`password must be at least ${MIN_PASSWORD_LENGTH} characters`);
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
  headers?: { get(name: string): string | null };
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
 * Like `verifyRequestAuth` but ALSO honors the per-install internal
 * bypass token (`INTERNAL_TOKEN_HEADER`). Use on routes a CLI helper
 * needs to hit — `scripts/approve-login.ts` reads the token directly
 * from `~/.claude/bridge.json#auth.internalToken` and calls back to
 * the running bridge with it, so a terminal user can approve a
 * pending device login without having a browser cookie.
 *
 * Same return shape as `verifyRequestAuth`. The internal-token path
 * returns a synthetic payload (`sub: cfg.email, exp: ∞`) so callers
 * that read `payload.sub` keep working uniformly.
 */
export function verifyRequestAuthOrInternal(
  req: RequestLike,
): SessionPayload | null {
  const cookieAuthed = verifyRequestAuth(req);
  if (cookieAuthed) return cookieAuthed;
  const cfg = loadAuthConfig();
  if (!cfg || !cfg.internalToken) return null;
  const internal = req.headers?.get(INTERNAL_TOKEN_HEADER);
  if (!internal || internal !== cfg.internalToken) return null;
  return {
    sub: cfg.email,
    exp: Number.MAX_SAFE_INTEGER,
  };
}

/**
 * Persist the live bridge's HTTP origin into `bridge.json#runtime` so
 * CLI scripts (`scripts/approve-login.ts` etc.) can find the running
 * server without the operator having to remember which port `bun
 * dev` vs `bun start` bound to. Called once per startup from
 * `instrumentation.ts`.
 *
 * Failures are swallowed — this is metadata for convenience, not
 * load-bearing config. If we can't write it, the script falls back to
 * BRIDGE_URL / PORT env vars.
 */
export function writeRuntimeMeta(args: { url: string; port: number }): void {
  try {
    updateBridgeManifest((m) => ({
      ...m,
      runtime: {
        url: args.url,
        port: args.port,
        pid: process.pid,
        startedAt: new Date().toISOString(),
      },
    }));
  } catch (err) {
    console.warn("[bridge] writeRuntimeMeta failed (non-fatal):", err);
  }
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
