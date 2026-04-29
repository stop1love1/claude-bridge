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
import { clearSetupToken, verifySetupToken } from "@/libs/setupToken";

export const dynamic = "force-dynamic";

interface SetupBody {
  email?: string;
  password?: string;
  confirmPassword?: string;
  /** Friendly label saved with the auto-trusted device for this setup. */
  label?: string;
  /**
   * One-time token minted at server boot when no `auth` block exists
   * in `bridge.json` and printed to the operator's terminal. Required
   * because the previous Host-header check is spoofable when the
   * bridge is bound to a non-loopback interface.
   */
  setupToken?: string;
}

/** Header equivalent of `setupToken` so CLI / curl callers can avoid JSON. */
const SETUP_TOKEN_HEADER = "x-bridge-setup-token";

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
 *   2. Caller didn't echo back the one-time setup token printed in the
 *      bridge boot banner → 401. Replaces the previous Host-header
 *      check (spoofable when the bridge binds to a non-loopback
 *      interface). The Host check stays as defense-in-depth.
 *   3. Request's `Host` header isn't a loopback hostname → 403.
 *      Defense-in-depth only; the token is the real gate now.
 *
 * On success returns `{ ok: true, user: { email } }` and unlinks the
 * setup token file so the endpoint becomes inert until the next boot
 * (which only mints a fresh token if no auth has been configured —
 * i.e., never, after a successful first run).
 */
export async function POST(req: NextRequest) {
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

  // Token gate runs BEFORE we look at credentials so a wrong-token
  // request can't be used to brute-force the email field's existence
  // (timing or otherwise). Accept the token from either the JSON body
  // or `x-bridge-setup-token` header so curl / CLI callers don't have
  // to wrap it in a JSON object.
  const providedToken =
    (typeof body.setupToken === "string" ? body.setupToken.trim() : "") ||
    (req.headers.get(SETUP_TOKEN_HEADER) ?? "").trim();
  if (!verifySetupToken(providedToken)) {
    return NextResponse.json(
      {
        error: "invalid or missing setup token",
        hint: "copy the one-time token printed in the bridge terminal banner (`[bridge] auth MISSING …`) into the setup form, or run `bun scripts/set-password.ts`",
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

  // setOperatorCredentials writes the auth block + generates the
  // signing secret + internal token if absent.
  await setOperatorCredentials(email, password);
  // Token has done its job — unlink so a leak / file copy after this
  // point can't replay setup. clearSetupToken is idempotent and the
  // 409 / `isAuthConfigured` gate above already protects against a
  // duplicate setup, but defense-in-depth is cheap.
  clearSetupToken();

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
  res.cookies.set(COOKIE_NAME, token, sessionCookieOptions(TRUSTED_TTL_MS));
  return res;
}

/**
 * Defense-in-depth check: is the `Host` header a loopback hostname?
 *
 * The Host header is set by the client (not by the underlying TCP
 * connection), so a LAN visitor could send `Host: localhost` and
 * pass this gate trivially when the bridge is bound to `0.0.0.0`.
 * That's exactly why the real gate is now the boot-banner setup
 * token — see `libs/setupToken.ts`. Keeping the Host check costs
 * nothing and blocks the trivial case where someone navigated to
 * `http://<lan-ip>:7777/login` without bothering to forge headers.
 *
 * NOTE: `0.0.0.0` is NOT a loopback address (it's the wildcard bind
 * address). We deliberately omit it from the accept list so a request
 * that explicitly arrived through the public interface can't pretend
 * to be local just because the operator happened to bind there.
 */
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
