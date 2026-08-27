
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
import {
  findValidDevice,
  getShare,
  isShareUsable,
  type Share,
  type ShareGrants,
} from "./shareStore";

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

const SCRYPT_N = 131072;
const SCRYPT_r = 8;
const SCRYPT_p = 1;
const SCRYPT_KEYLEN = 64;
const SALT_BYTES = 16;
const SCRYPT_MAX_N = 1 << 20;

export const MIN_PASSWORD_LENGTH = 12;

export const COOKIE_NAME = "bridge_session";
export const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
export const TRUSTED_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const INTERNAL_TOKEN_HEADER = "x-bridge-internal-token";

const CT_BLIND_KEY = randomBytes(32);

export function constantTimeStringEqual(
  a: string | null | undefined,
  b: string | null | undefined,
): boolean {
  if (typeof a !== "string" || typeof b !== "string") return false;
  if (a.length === 0 || b.length === 0) return false;
  const digA = createHmac("sha256", CT_BLIND_KEY).update(a, "utf8").digest();
  const digB = createHmac("sha256", CT_BLIND_KEY).update(b, "utf8").digest();
  return timingSafeEqual(digA, digB);
}

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


export interface TrustedDevice {
  id: string;
  label?: string;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
}

export interface AuthConfig {
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
}

export function isAuthConfigured(): boolean {
  return loadAuthConfig() !== null;
}


export async function hashPassword(plain: string): Promise<string> {
  if (!plain || typeof plain !== "string") {
    throw new Error("password must be a non-empty string");
  }
  const salt = randomBytes(SALT_BYTES);
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
  if (N < 16384 || N > SCRYPT_MAX_N || r < 1 || r > 32 || p < 1 || p > 16) return false;
  if ((N & (N - 1)) !== 0) return false;
  let salt: Buffer; let expected: Buffer;
  try {
    salt = Buffer.from(parts[4], "base64");
    expected = Buffer.from(parts[5], "base64");
  } catch { return false; }
  const maxmem = 256 * N * r;
  const actual = await scrypt(plain, salt, expected.length, { N, r, p, maxmem });
  if (actual.length !== expected.length) return false;
  return timingSafeEqual(actual, expected);
}


export interface SessionPayload {
  sub: string;
  exp: number;
  did?: string;
  kind?: "operator" | "guest";
  sid?: string;
  tid?: string;
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
  if (payload.did && !findTrustedDevice(payload.did)) return null;
  return payload;
}

export function verifyRequestAuthOrInternal(
  req: RequestLike,
): SessionPayload | null {
  const cookieAuthed = verifyRequestAuth(req);
  if (cookieAuthed) return cookieAuthed;
  const cfg = loadAuthConfig();
  if (!cfg || !cfg.internalToken) return null;
  const internal = req.headers?.get(INTERNAL_TOKEN_HEADER);
  if (!constantTimeStringEqual(internal, cfg.internalToken)) return null;
  return {
    sub: cfg.email,
    exp: Number.MAX_SAFE_INTEGER,
  };
}


export const GUEST_COOKIE_MAX_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export function signGuestSession(args: {
  shareId: string;
  taskId: string;
  did: string;
  deviceTtlMs: number | null;
}): { token: string; maxAgeMs: number } {
  const cfg = loadAuthConfig();
  if (!cfg) throw new Error("auth not configured");
  const maxAgeMs =
    args.deviceTtlMs === null
      ? GUEST_COOKIE_MAX_TTL_MS
      : Math.min(args.deviceTtlMs, GUEST_COOKIE_MAX_TTL_MS);
  const payload: SessionPayload = {
    sub: "guest",
    kind: "guest",
    sid: args.shareId,
    tid: args.taskId,
    did: args.did,
    exp: Date.now() + maxAgeMs,
  };
  return { token: signSession(payload, cfg.secret), maxAgeMs };
}

export type Actor =
  | { kind: "operator"; payload: SessionPayload }
  | { kind: "guest"; share: Share; taskId: string; did: string; grants: ShareGrants };

export function verifyRequestActor(req: RequestLike): Actor | null {
  const cfg = loadAuthConfig();
  if (!cfg) return null;

  const internal = req.headers?.get(INTERNAL_TOKEN_HEADER);
  if (internal && cfg.internalToken && constantTimeStringEqual(internal, cfg.internalToken)) {
    return { kind: "operator", payload: { sub: cfg.email, exp: Number.MAX_SAFE_INTEGER } };
  }

  const token = req.cookies.get(COOKIE_NAME)?.value;
  if (!token) return null;
  const payload = verifySession(token, cfg.secret);
  if (!payload) return null;

  if (payload.kind === "guest") {
    return resolveGuest(payload);
  }

  if (payload.did && !findTrustedDevice(payload.did)) return null;
  return { kind: "operator", payload };
}

function resolveGuest(payload: SessionPayload): Actor | null {
  if (!payload.sid || !payload.tid || !payload.did) return null;
  const share = getShare(payload.sid);
  if (!share || !isShareUsable(share)) return null;
  if (share.taskId !== payload.tid) return null;
  if (!findValidDevice(share, payload.did)) return null;
  return {
    kind: "guest",
    share,
    taskId: share.taskId,
    did: payload.did,
    grants: share.grants,
  };
}

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

export function getOrCreateInternalToken(): string {
  const existing = loadAuthConfig();
  if (existing && existing.internalToken) return existing.internalToken;
  if (!existing) {
    return "";
  }
  const internalToken = b64urlEncode(randomBytes(32));
  saveAuthConfig({ ...existing, internalToken });
  return internalToken;
}
