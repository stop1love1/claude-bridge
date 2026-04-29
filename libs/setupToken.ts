/**
 * First-run setup token — defends `POST /api/auth/setup` against
 * Host-header spoofing.
 *
 * The previous gate (`isLoopbackRequest`) inspected the request's `Host`
 * header to decide whether the caller was local. That header is set by
 * the client, not by the connection, so a stranger on the LAN can send
 * `Host: localhost` and pass the check whenever the bridge is bound to
 * a non-loopback interface.
 *
 * To close that hole without forcing the operator into a CLI flow, the
 * bridge mints a fresh setup token on every boot when no `auth` block
 * exists in `bridge.json`, writes it to `<BRIDGE_STATE_DIR>/setup-token`
 * (mode 0o600 on POSIX), and prints it in the `[bridge]` boot banner.
 * The setup endpoint requires the operator to echo the token back —
 * which is information only someone with access to the bridge process
 * stdout or the bridge state dir can have. Once the operator has
 * created their credentials, the token file is unlinked; password
 * rotations from then on must go through `bun scripts/set-password.ts`,
 * matching the CLI-only rotation policy already documented in
 * `app/api/auth/setup/route.ts`.
 */
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

const SETUP_TOKEN_FILE = join(BRIDGE_STATE_DIR, "setup-token");

function b64urlEncode(buf: Buffer): string {
  return buf
    .toString("base64")
    .replace(/=+$/, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

/**
 * Read or mint the setup token.
 *
 * Idempotent within a single boot: if `<state>/setup-token` already
 * holds a value, that's returned as-is so an HMR-triggered re-call
 * doesn't invalidate the token the boot banner already showed the
 * operator. On a fresh boot the file is recreated with a 32-byte
 * random token.
 */
export function ensureSetupToken(): string {
  try {
    mkdirSync(dirname(SETUP_TOKEN_FILE), { recursive: true });
  } catch {
    // Best-effort. `writeFileSync` below will surface real errors.
  }
  if (existsSync(SETUP_TOKEN_FILE)) {
    try {
      const cached = readFileSync(SETUP_TOKEN_FILE, "utf8").trim();
      if (cached) return cached;
    } catch {
      // Unreadable / corrupt — fall through and regenerate.
    }
  }
  const token = b64urlEncode(randomBytes(32));
  writeFileSync(SETUP_TOKEN_FILE, token + "\n");
  if (process.platform !== "win32") {
    try {
      chmodSync(SETUP_TOKEN_FILE, 0o600);
    } catch {
      // Best-effort — Windows doesn't honor POSIX modes anyway, and on
      // POSIX a chmod failure would mean the file system doesn't
      // support it. The token's compromised window is bounded by the
      // first successful setup either way.
    }
  }
  return token;
}

/**
 * Constant-time compare of a caller-supplied token against the on-disk
 * value. Returns false when no token file exists or the inputs differ
 * in length. Never throws.
 */
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

/**
 * Delete the token file. Called from the setup endpoint after the
 * operator's credentials have been written, and from the boot banner
 * when an `auth` block is already present (cleans up a stale token
 * left over from a crash between `setOperatorCredentials` and
 * `clearSetupToken`).
 */
export function clearSetupToken(): void {
  try {
    if (existsSync(SETUP_TOKEN_FILE)) unlinkSync(SETUP_TOKEN_FILE);
  } catch (err) {
    console.warn("[bridge] failed to clear setup token (non-fatal):", err);
  }
}

/** True when a setup token file exists on disk. */
export function hasSetupToken(): boolean {
  return existsSync(SETUP_TOKEN_FILE);
}

/** Test-only: expose the token file path so tests can clean up. */
export const SETUP_TOKEN_PATH = SETUP_TOKEN_FILE;
