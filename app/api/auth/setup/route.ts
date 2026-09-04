import { NextResponse, type NextRequest } from "next/server";
import {
  COOKIE_NAME,
  MIN_PASSWORD_LENGTH,
  TRUSTED_TTL_MS,
  addTrustedDevice,
  isAuthConfigured,
  isValidEmail,
  loadAuthConfig,
  sessionCookieOptions,
  setOperatorCredentials,
  signSession,
} from "@/libs/auth";
import { checkCsrf } from "@/libs/csrf";
import { getClientIp } from "@/libs/clientIp";
import { DEMO_MODE } from "@/libs/demoMode";
import { checkRateLimit } from "@/libs/rateLimit";
import { clearSetupToken, verifySetupToken } from "@/libs/setupToken";

export const dynamic = "force-dynamic";

interface SetupBody {
  email?: string;
  password?: string;
  confirmPassword?: string;
  label?: string;
  setupToken?: string;
}

const SETUP_TOKEN_HEADER = "x-bridge-setup-token";

export async function POST(req: NextRequest) {
  if (DEMO_MODE) {
    return NextResponse.json({ error: "demo mode" }, { status: 503 });
  }
  const ip = getClientIp(req.headers);
  const denied = checkRateLimit("auth:setup", ip, 50, 10 * 60_000);
  if (denied) {
    return NextResponse.json(denied.body, {
      status: denied.status,
      headers: denied.headers,
    });
  }

  const csrf = checkCsrf(req);
  if (!csrf.ok) {
    return NextResponse.json(
      { error: "csrf check failed", reason: csrf.reason ?? null },
      { status: 403 },
    );
  }

  if (isAuthConfigured()) {
    return NextResponse.json(
      {
        error: "auth already configured",
        hint: "to rotate the password, run `npm run set:password` from the bridge repo",
      },
      { status: 409 },
    );
  }

  if (!isLoopbackRequest(req)) {
    return NextResponse.json(
      {
        error: "first-run setup is restricted to localhost",
        hint: "open the bridge from `http://localhost:7777` on the same machine, or run `npm run set:password`",
      },
      { status: 403 },
    );
  }

  let body: SetupBody;
  try {
    body = (await req.json()) as SetupBody;
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const providedToken =
    (typeof body.setupToken === "string" ? body.setupToken.trim() : "") ||
    (req.headers.get(SETUP_TOKEN_HEADER) ?? "").trim();
  if (!verifySetupToken(providedToken)) {
    return NextResponse.json(
      {
        error: "invalid or missing setup token",
        hint: "copy the one-time token printed in the bridge terminal banner (`[bridge] auth MISSING …`) into the setup form, or run `npm run set:password`",
      },
      { status: 401 },
    );
  }

  const email = (body.email ?? "").trim();
  const password = body.password ?? "";
  const confirm = body.confirmPassword ?? "";

  if (!email) return NextResponse.json({ error: "email required" }, { status: 400 });
  if (!isValidEmail(email)) {
    return NextResponse.json({ error: "invalid email format" }, { status: 400 });
  }
  if (password.length < MIN_PASSWORD_LENGTH) {
    return NextResponse.json(
      { error: `password must be at least ${MIN_PASSWORD_LENGTH} characters` },
      { status: 400 },
    );
  }
  if (confirm && confirm !== password) {
    return NextResponse.json(
      { error: "password confirmation does not match" },
      { status: 400 },
    );
  }

  await setOperatorCredentials(email, password);
  clearSetupToken();

  const cfg = loadAuthConfig();
  if (!cfg) {
    return NextResponse.json(
      { error: "internal error: auth config not loadable after setup" },
      { status: 500 },
    );
  }
  const label = pickDeviceLabel(req, body.label);
  const { device } = addTrustedDevice(label);
  const exp = Date.now() + TRUSTED_TTL_MS;
  const token = signSession({ sub: cfg.email, exp, did: device.id }, cfg.secret);

  const res = NextResponse.json({ ok: true, user: { email: cfg.email } });
  res.cookies.set(COOKIE_NAME, token, sessionCookieOptions(TRUSTED_TTL_MS));
  return res;
}

function isLoopbackRequest(req: NextRequest): boolean {
  const host = req.headers.get("host") ?? "";
  if (!host) return false;
  const stripPort = host.replace(/:\d+$/, "").replace(/^\[|\]$/g, "").toLowerCase();
  return (
    stripPort === "localhost" ||
    stripPort === "127.0.0.1" ||
    stripPort === "::1"
  );
}

function pickDeviceLabel(req: NextRequest, override: string | undefined): string {
  if (override && override.trim()) return override.trim().slice(0, 80);
  const ua = req.headers.get("user-agent") ?? "";
  if (!ua) return "Setup device";

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

  return `Setup · ${browser} on ${os}`.slice(0, 80);
}
