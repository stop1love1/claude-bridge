import { NextResponse, type NextRequest } from "next/server";
import {
  COOKIE_NAME,
  SESSION_TTL_MS,
  TRUSTED_TTL_MS,
  addTrustedDevice,
  isValidEmail,
  loadAuthConfig,
  pruneExpired,
  signSession,
  verifyPassword,
} from "@/lib/auth";
import {
  APPROVAL_TTL_MS,
  createPendingLogin,
} from "@/lib/loginApprovals";

export const dynamic = "force-dynamic";

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
 * On bad credentials returns 401 with a generic error (no "user not
 * found" leak).
 */
export async function POST(req: NextRequest) {
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

  // Always run the scrypt verify even when the email doesn't match,
  // so timing doesn't leak whether the operator exists. Single-user
  // install means this is mostly cosmetic — but cheap to do right.
  const emailOk = email.toLowerCase() === cfg.email.toLowerCase();
  const passOk = await verifyPassword(password, cfg.passwordHash);
  if (!emailOk || !passOk) {
    return NextResponse.json({ error: "invalid credentials" }, { status: 401 });
  }

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
    const remoteIp =
      req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
      req.headers.get("x-real-ip") ||
      "unknown";
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
  res.cookies.set(COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: "lax",
    // No `secure` flag in dev — the bridge runs on http://localhost.
    // In production behind TLS this should be true; since the bridge
    // is meant for localhost-only use we leave it off.
    secure: false,
    path: "/",
    maxAge: Math.floor(ttl / 1000),
  });
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
