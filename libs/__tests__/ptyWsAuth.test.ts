import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Runs against a temp `~/.claude/bridge.json` (same pattern as
 * `auth.test.ts`) so these tests never touch the operator's real
 * credentials, and so `authorizePtyUpgrade` — which internally calls
 * `verifyRequestAuth` / `consumePtyWsTicket` — sees a config it
 * controls.
 */

let tempHome: string;
let originalHome: string | undefined;

function writeAuthConfig(payload: object): void {
  const claudeDir = join(tempHome, ".claude");
  mkdirSync(claudeDir, { recursive: true });
  writeFileSync(join(claudeDir, "bridge.json"), JSON.stringify(payload), "utf8");
}

const AUTH_SECRET = "test-secret";
const INTERNAL_TOKEN = "the-real-internal-token";

beforeEach(() => {
  tempHome = mkdtempSync(join(tmpdir(), "bridge-ptywsauth-test-"));
  originalHome = process.env.HOME;
  process.env.HOME = tempHome;
  process.env.USERPROFILE = tempHome;
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  vi.spyOn(require("node:os"), "homedir").mockReturnValue(tempHome);
  vi.resetModules();
  writeAuthConfig({
    auth: {
      email: "operator@example.com",
      passwordHash: "scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAA==",
      secret: AUTH_SECRET,
      internalToken: INTERNAL_TOKEN,
      trustedDevices: [],
    },
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  try {
    rmSync(tempHome, { recursive: true, force: true });
  } catch {
    /* best-effort cleanup */
  }
});

describe("authorizePtyUpgrade", () => {
  it("rejects a raw internal token with no ticket", async () => {
    const { authorizePtyUpgrade } = await import("../ptyWsAuth");
    const r = authorizePtyUpgrade({
      cookieHeader: undefined,
      internalTokenHeader: INTERNAL_TOKEN,
      ticket: undefined,
    });
    expect(r.ok).toBe(false);
  });

  it("accepts a valid one-time ticket", async () => {
    const { authorizePtyUpgrade } = await import("../ptyWsAuth");
    const { mintPtyWsTicket } = await import("../ptyWsTickets");
    const ticket = mintPtyWsTicket("operator@example.com");
    const r = authorizePtyUpgrade({
      cookieHeader: undefined,
      internalTokenHeader: undefined,
      ticket,
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.sub).toBe("operator@example.com");
  });

  it("accepts a valid session cookie", async () => {
    const { authorizePtyUpgrade } = await import("../ptyWsAuth");
    const { signSession, COOKIE_NAME } = await import("../auth");
    const token = signSession(
      { sub: "operator@example.com", exp: Date.now() + 60_000 },
      AUTH_SECRET,
    );
    const r = authorizePtyUpgrade({
      cookieHeader: `${COOKIE_NAME}=${token}`,
      internalTokenHeader: undefined,
      ticket: undefined,
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.sub).toBe("operator@example.com");
  });

  it("rejects when nothing is provided", async () => {
    const { authorizePtyUpgrade } = await import("../ptyWsAuth");
    const r = authorizePtyUpgrade({
      cookieHeader: undefined,
      internalTokenHeader: undefined,
      ticket: undefined,
    });
    expect(r.ok).toBe(false);
  });

  it("rejects an expired/unknown ticket even with a valid-looking internal token", async () => {
    const { authorizePtyUpgrade } = await import("../ptyWsAuth");
    const r = authorizePtyUpgrade({
      cookieHeader: undefined,
      internalTokenHeader: INTERNAL_TOKEN,
      ticket: "not-a-real-ticket",
    });
    expect(r.ok).toBe(false);
  });
});
