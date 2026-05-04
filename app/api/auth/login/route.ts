import { NextResponse, type NextRequest } from "next/server";
import {
  COOKIE_NAME,
  SESSION_TTL_MS,
  TRUSTED_TTL_MS,
  addTrustedDevice,
  isValidEmail,
  loadAuthConfig,
  pruneExpired,
  sessionCookieOptions,
  signSession,
  verifyPassword,
} from "@/libs/auth";
import {
  APPROVAL_TTL_MS,
  createPendingLogin,
} from "@/libs/loginApprovals";
import { getClientIp } from "@/libs/clientIp";
import { checkCsrf } from "@/libs/csrf";
import { DEMO_MODE } from "@/libs/demoMode";
import { rateLimit, rateLimitClear } from "@/libs/rateLimit";

export const dynamic = "force-dynamic";

/**
 * Brute-force defense. The bridge is a single-user system, so a
 * legitimate operator should never need more than ~5 attempts in a
 * 10-minute window. Two parallel limiters because IP-only and
 * email-only each have failure modes:
 *
 *  - IP-only: NAT'd LAN means everyone in the office shares one
 *    bucket. Tighter limit + per-email backup keeps that workable.
 *  - Email-only: an attacker rotating IPs (Tor, residential proxy
 *    pool) defeats per-IP. Per-email locks the account out
 *    regardless of source.
 *
 * On a successful login we clear BOTH buckets so a typo-prone user
 * isn't punished after they finally type the right password.
 */
const LOGIN_WINDOW_MS = 10 * 60 * 1000;
// Per-IP cap is generous (50) because when BRIDGE_TRUSTED_PROXY isn't
// set, getClientIp() returns the "unknown" sentinel and every caller
// shares one bucket — a tight cap would let one clumsy tab lock out
// the whole bridge. The per-email cap is the real brute-force gate
// (5 attempts per email per 10 min) and stays load-bearing.
const LOGIN_LIMIT_PER_IP = 50;
const LOGIN_LIMIT_PER_EMAIL = 5;

interface LoginBody {
  email?: string;
  password?: string;
  trust?: boolean;
  /** Optional friendly label for the trusted-device entry. */
  label?: string;
}

/**
 * POST /api/auth/login
 *
 * Body: `{ email, password, trust?, label? }`. Verifies the operator
 * credentials against `~/.claude/bridge.json#auth` and sets the
 * `bridge_session` cookie. With `trust: true` we also register a
 * trusted-device entry so the cookie persists for 30 days; otherwise
 * the cookie is short-lived (12h) and not server-revocable.
 *
 * On success returns `{ ok: true, user: { email }, trusted: bool }`.
 * On bad credentials returns 401 with a specific `error` string: wrong
 * operator email vs wrong password (single-user bridge — no tenant
 * enumeration concern).
 */
export async function POST(req: NextRequest) {
  // /api/auth/* is excluded from the proxy matcher (so the login form
  // can hit this endpoint without already being authed), which also
  // means the proxy's demo-mode 503 doesn't reach us. Short-circuit
  // here so a deployed demo instance can't accept login attempts.
  if (DEMO_MODE) {
    return NextResponse.json({ error: "demo mode" }, { status: 503 });
  }
  // /api/auth/* is excluded from the proxy's CSRF check, so we
  // perform it inline. Doing this before the rate-limit bucket
  // increment avoids letting a CSRF attempt burn the operator's
  // login budget.
  const csrf = checkCsrf(req);
  if (!csrf.ok) {
    return NextResponse.json(
      { error: "csrf check failed", reason: csrf.reason ?? null },
      { status: 403 },
    );
  }

  const cfg = loadAuthConfig();
  if (!cfg) {
    return NextResponse.json(
      { error: "auth not configured", hint: "run `bun scripts/set-password.ts`" },
      { status: 503 },
    );
  }

  let body: LoginBody;
  try {
    body = (await req.json()) as LoginBody;
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const email = (body.email ?? "").trim();
  const password = body.password ?? "";
  if (!email || !password) {
    return NextResponse.json({ error: "email and password required" }, { status: 400 });
  }
  if (!isValidEmail(email)) {
    return NextResponse.json({ error: "invalid email format" }, { status: 400 });
  }

  // Rate-limit BEFORE we run scrypt — otherwise a hostile client
  // forces ~150ms of CPU per request and DoS's us. Keying the email
  // bucket on lowercase form prevents a trivial bypass via casing.
  const ip = getClientIp(req.headers);
  const ipCheck = rateLimit("login:ip", ip, LOGIN_LIMIT_PER_IP, LOGIN_WINDOW_MS);
  const emailCheck = rateLimit(
    "login:email",
    email.toLowerCase(),
    LOGIN_LIMIT_PER_EMAIL,
    LOGIN_WINDOW_MS,
  );
  if (!ipCheck.ok || !emailCheck.ok) {
    const retryAfterMs = Math.max(ipCheck.retryAfterMs, emailCheck.retryAfterMs);
    return NextResponse.json(
      {
        error: "too many login attempts",
        hint: "wait a few minutes before retrying",
      },
      {
        status: 429,
        headers: { "Retry-After": String(Math.ceil(retryAfterMs / 1000)) },
      },
    );
  }

  // Always run the scrypt verify even when the email doesn't match,
  // so timing doesn't leak whether the operator exists. Single-user
  // install means this is mostly cosmetic — but cheap to do right.
  const emailOk = email.toLowerCase() === cfg.email.toLowerCase();
  const passOk = await verifyPassword(password, cfg.passwordHash);
  if (!emailOk || !passOk) {
    const error = !emailOk
      ? "The email address does not match the operator account on this bridge."
      : "The password is incorrect.";
    return NextResponse.json({ error }, { status: 401 });
  }

  // Successful auth — wipe both buckets so a typo'd password earlier
  // in the window doesn't keep counting against the operator.
  rateLimitClear("login:ip", ip);
  rateLimitClear("login:email", email.toLowerCase());

  const trust = body.trust === true;
  const now = Date.now();
  const ttl = trust ? TRUSTED_TTL_MS : SESSION_TTL_MS;
  const exp = now + ttl;

  // Device-approval gate: when there's already an active trusted
  // device, a NEW login (regardless of `trust`) has to be approved
  // by that existing device before the cookie is signed. Without
  // any trusted devices we treat this as a bootstrap login — the
  // first-ever login on a fresh install can't ask for approval from
  // anyone, so it just proceeds.
  const liveTrusted = pruneExpired(cfg.trustedDevices);
  if (liveTrusted.length > 0) {
    const label = pickDeviceLabel(req, body.label);
    // M2: only trust XFF / X-Real-IP when BRIDGE_TRUSTED_PROXY=1, else
    // fall back to whatever Next exposes. See libs/clientIp.ts.
    const remoteIp = ip;
    const userAgent = req.headers.get("user-agent") ?? "";
    const pending = createPendingLogin({
      email: cfg.email,
      trust,
      deviceLabel: label,
      remoteIp,
      userAgent,
    });
    return NextResponse.json(
      {
        status: "pending",
        pendingId: pending.id,
        deviceLabel: label,
        expiresAt: new Date(pending.expiresAt).toISOString(),
        ttlMs: APPROVAL_TTL_MS,
      },
      { status: 202 },
    );
  }

  let deviceId: string | undefined;
  if (trust) {
    const label = pickDeviceLabel(req, body.label);
    const { device } = addTrustedDevice(label);
    deviceId = device.id;
  }

  // Re-load secret AFTER `addTrustedDevice` since that re-reads/writes
  // the file; secret itself doesn't change but stay safe.
  const secret = loadAuthConfig()?.secret ?? cfg.secret;
  const token = signSession({ sub: cfg.email, exp, did: deviceId }, secret);

  const res = NextResponse.json({
    ok: true,
    user: { email: cfg.email },
    trusted: trust,
  });
  res.cookies.set(COOKIE_NAME, token, sessionCookieOptions(ttl));
  return res;
}

/**
 * Best-effort device label. The operator can override via `body.label`;
 * otherwise we synthesize from the User-Agent header so the trusted-
 * devices list is recognizable ("Chrome on Windows", etc.). No external
 * UA-parser dep — a couple of regex sniffs is plenty for the use case.
 */
function pickDeviceLabel(req: NextRequest, override: string | undefined): string {
  if (override && override.trim()) return override.trim().slice(0, 80);
  const ua = req.headers.get("user-agent") ?? "";
  if (!ua) return "Unknown device";

  let browser = "Browser";
  if (/Edg\//.test(ua)) browser = "Edge";
  else if (/OPR\//.test(ua)) browser = "Opera";
  else if (/Firefox\//.test(ua)) browser = "Firefox";
  else if (/Chrome\//.test(ua)) browser = "Chrome";
  else if (/Safari\//.test(ua) && !/Chrome\//.test(ua)) browser = "Safari";

  let os = "Unknown OS";
  if (/Windows NT 11/.test(ua)) os = "Windows 11";
  else if (/Windows NT 10/.test(ua)) os = "Windows 10";
  else if (/Mac OS X/.test(ua)) os = "macOS";
  else if (/Android/.test(ua)) os = "Android";
  else if (/iPhone|iPad|iPod/.test(ua)) os = "iOS";
  else if (/Linux/.test(ua)) os = "Linux";

  return `${browser} on ${os}`.slice(0, 80);
}
