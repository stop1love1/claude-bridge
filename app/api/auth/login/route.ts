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

const LOGIN_WINDOW_MS = 10 * 60 * 1000;
const LOGIN_LIMIT_PER_IP = 50;
const LOGIN_LIMIT_PER_EMAIL = 5;

interface LoginBody {
  email?: string;
  password?: string;
  trust?: boolean;
  label?: string;
}

export async function POST(req: NextRequest) {
  if (DEMO_MODE) {
    return NextResponse.json({ error: "demo mode" }, { status: 503 });
  }
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

  // One message for both failure modes, deliberately. Naming which half was
  // wrong tells a caller they've found the operator's email and only the
  // password is left — and this bridge can be published to the internet in one
  // click from the Tunnels page. `verifyPassword` runs even when the email is
  // already wrong so the response time doesn't leak the same fact.
  const emailOk = email.toLowerCase() === cfg.email.toLowerCase();
  const passOk = await verifyPassword(password, cfg.passwordHash);
  if (!emailOk || !passOk) {
    return NextResponse.json(
      { error: "Email or password is incorrect." },
      { status: 401 },
    );
  }

  rateLimitClear("login:ip", ip);
  rateLimitClear("login:email", email.toLowerCase());

  const trust = body.trust === true;
  const now = Date.now();
  const ttl = trust ? TRUSTED_TTL_MS : SESSION_TTL_MS;
  const exp = now + ttl;

  const liveTrusted = pruneExpired(cfg.trustedDevices);
  if (liveTrusted.length > 0) {
    const label = pickDeviceLabel(req, body.label);
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
