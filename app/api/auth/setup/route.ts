import { NextResponse, type NextRequest } from "next/server";
import {
  COOKIE_NAME,
  TRUSTED_TTL_MS,
  addTrustedDevice,
  isAuthConfigured,
  isValidEmail,
  loadAuthConfig,
  setOperatorCredentials,
  signSession,
} from "@/lib/auth";

export const dynamic = "force-dynamic";

interface SetupBody {
  email?: string;
  password?: string;
  confirmPassword?: string;
  /** Friendly label saved with the auto-trusted device for this setup. */
  label?: string;
}

/**
 * POST /api/auth/setup
 *
 * First-run setup endpoint. Creates the operator's email + password
 * credentials AND signs them in (sets `bridge_session` cookie with
 * `trust: true`) so the redirect after setup lands on `/` already
 * authenticated — no second login round-trip.
 *
 * Hard refusals:
 *   1. `auth` block already exists in `bridge.json` → 409. Re-running
 *      setup from the UI would let any visitor reset the password,
 *      which is exactly the race the original implementation called
 *      out as a security hole. Operator MUST use the CLI
 *      (`bun scripts/set-password.ts`) to rotate a forgotten password.
 *   2. Request looks like it came from somewhere other than localhost
 *      → 403. The bridge listens on the loopback by default; if the
 *      operator bound to `0.0.0.0` we still want to keep first-run
 *      setup CLI-only on the public interface so a stranger on the
 *      LAN can't claim the password before the operator types it.
 *
 * On success returns `{ ok: true, user: { email } }`.
 */
export async function POST(req: NextRequest) {
  if (isAuthConfigured()) {
    return NextResponse.json(
      {
        error: "auth already configured",
        hint: "to rotate the password, run `bun scripts/set-password.ts` from the bridge repo",
      },
      { status: 409 },
    );
  }

  if (!isLoopbackRequest(req)) {
    return NextResponse.json(
      {
        error: "first-run setup is restricted to localhost",
        hint: "open the bridge from `http://localhost:7777` on the same machine, or run `bun scripts/set-password.ts`",
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

  const email = (body.email ?? "").trim();
  const password = body.password ?? "";
  const confirm = body.confirmPassword ?? "";

  if (!email) return NextResponse.json({ error: "email required" }, { status: 400 });
  if (!isValidEmail(email)) {
    return NextResponse.json({ error: "invalid email format" }, { status: 400 });
  }
  if (password.length < 8) {
    return NextResponse.json(
      { error: "password must be at least 8 characters" },
      { status: 400 },
    );
  }
  if (confirm && confirm !== password) {
    return NextResponse.json(
      { error: "password confirmation does not match" },
      { status: 400 },
    );
  }

  // setOperatorCredentials writes the auth block + generates the
  // signing secret + internal token if absent.
  await setOperatorCredentials(email, password);

  // Auto-trust this device + sign a 30-day cookie so the operator
  // doesn't have to log in again immediately after setting the
  // password.
  const cfg = loadAuthConfig();
  if (!cfg) {
    // Should never happen — `setOperatorCredentials` just wrote the file.
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
  res.cookies.set(COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: false,
    path: "/",
    maxAge: Math.floor(TRUSTED_TTL_MS / 1000),
  });
  return res;
}

/**
 * True when the request came from a loopback address. We rely on the
 * Host header (`localhost`, `127.0.0.1`, `[::1]` with or without port)
 * since Next.js's `request.ip` is not portable across runtimes. This
 * means an operator who explicitly binds the dev server to a public
 * interface AND visits via `http://localhost` from the same box still
 * gets to set up — the connection IS loopback. A LAN visitor would
 * use the LAN IP in the Host header and be blocked.
 */
function isLoopbackRequest(req: NextRequest): boolean {
  const host = req.headers.get("host") ?? "";
  if (!host) return false;
  const stripPort = host.replace(/:\d+$/, "").replace(/^\[|\]$/g, "").toLowerCase();
  return (
    stripPort === "localhost" ||
    stripPort === "127.0.0.1" ||
    stripPort === "::1" ||
    stripPort === "0.0.0.0"
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
