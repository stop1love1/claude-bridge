import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  addDevice,
  createShare,
  revokeShare,
  _internal as shareInternal,
  _resetForTests as resetShares,
  type ShareGit,
  type ShareGrants,
} from "../shareStore";

/**
 * Integration test for `verifyRequestActor`: an operator cookie/internal
 * token resolves to an operator; a guest cookie resolves to a guest ONLY
 * while the live share + device are valid. Auth config lives in a temp
 * HOME; the share store's real `.bridge-state` file is snapshot/restored.
 */

let tempHome: string;
let originalHome: string | undefined;
let savedShares: string | null = null;

const SECRET = "test-secret-key";
const INTERNAL = "internal-token-xyz";
const GRANTS: ShareGrants = { sendMessage: true, spawnAgent: false, answerPermission: false, commit: false, push: false };
const GIT: ShareGit = { branchMode: "current", autoCommit: false, autoPush: false };

function writeAuthConfig(): void {
  const claudeDir = join(tempHome, ".claude");
  mkdirSync(claudeDir, { recursive: true });
  writeFileSync(
    join(claudeDir, "bridge.json"),
    JSON.stringify({
      auth: {
        email: "op@example.com",
        passwordHash: "scrypt$16384$8$1$c2FsdA$aGFzaA",
        secret: SECRET,
        internalToken: INTERNAL,
        trustedDevices: [],
      },
    }),
    "utf8",
  );
}

beforeEach(() => {
  tempHome = mkdtempSync(join(tmpdir(), "bridge-actor-test-"));
  originalHome = process.env.HOME;
  process.env.HOME = tempHome;
  process.env.USERPROFILE = tempHome;
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  vi.spyOn(require("node:os"), "homedir").mockReturnValue(tempHome);
  vi.resetModules();
  writeAuthConfig();
  savedShares = existsSync(shareInternal.SHARES_FILE)
    ? readFileSync(shareInternal.SHARES_FILE, "utf8")
    : null;
  resetShares();
  rmSync(shareInternal.SHARES_FILE, { force: true });
});

afterEach(() => {
  vi.restoreAllMocks();
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  try { rmSync(tempHome, { recursive: true, force: true }); } catch { /* best-effort */ }
  if (savedShares !== null) writeFileSync(shareInternal.SHARES_FILE, savedShares, "utf8");
  else rmSync(shareInternal.SHARES_FILE, { force: true });
  resetShares();
});

function fakeReq(cookie?: string, internal?: string): {
  cookies: { get(n: string): { value: string } | undefined };
  headers: { get(n: string): string | null };
} {
  return {
    cookies: { get: (n) => (n === "bridge_session" && cookie ? { value: cookie } : undefined) },
    headers: { get: (n) => (n === "x-bridge-internal-token" ? internal ?? null : null) },
  };
}

describe("verifyRequestActor — operator", () => {
  it("resolves the internal token to an operator", async () => {
    const { verifyRequestActor } = await import("../auth");
    const actor = verifyRequestActor(fakeReq(undefined, INTERNAL));
    expect(actor?.kind).toBe("operator");
  });

  it("returns null with no cookie and no token", async () => {
    const { verifyRequestActor } = await import("../auth");
    expect(verifyRequestActor(fakeReq())).toBeNull();
  });
});

describe("verifyRequestActor — guest", () => {
  it("resolves a valid guest cookie to a guest scoped to the share's task", async () => {
    const { signGuestSession, verifyRequestActor } = await import("../auth");
    const { share } = createShare({ taskId: "t_1", grants: GRANTS, git: GIT, deviceTtlMs: null });
    addDevice(share.id, { did: "gdv_a", label: "Alice", ip: "1.2.3.4" });
    const { token } = signGuestSession({ shareId: share.id, taskId: "t_1", did: "gdv_a", deviceTtlMs: null });

    const actor = verifyRequestActor(fakeReq(token));
    expect(actor?.kind).toBe("guest");
    if (actor?.kind === "guest") {
      expect(actor.taskId).toBe("t_1");
      expect(actor.grants.sendMessage).toBe(true);
    }
  });

  it("rejects a guest cookie once the share is revoked (instant)", async () => {
    const { signGuestSession, verifyRequestActor } = await import("../auth");
    const { share } = createShare({ taskId: "t_1", grants: GRANTS, git: GIT, deviceTtlMs: null });
    addDevice(share.id, { did: "gdv_a", label: "Alice", ip: "1.2.3.4" });
    const { token } = signGuestSession({ shareId: share.id, taskId: "t_1", did: "gdv_a", deviceTtlMs: null });

    expect(verifyRequestActor(fakeReq(token))?.kind).toBe("guest");
    revokeShare(share.id);
    expect(verifyRequestActor(fakeReq(token))).toBeNull();
  });

  it("rejects a guest cookie whose device was never approved", async () => {
    const { signGuestSession, verifyRequestActor } = await import("../auth");
    const { share } = createShare({ taskId: "t_1", grants: GRANTS, git: GIT, deviceTtlMs: null });
    // No addDevice → the did is not in the share.
    const { token } = signGuestSession({ shareId: share.id, taskId: "t_1", did: "gdv_ghost", deviceTtlMs: null });
    expect(verifyRequestActor(fakeReq(token))).toBeNull();
  });

  it("rejects a guest cookie whose task doesn't match the share", async () => {
    const { signGuestSession, verifyRequestActor } = await import("../auth");
    const { share } = createShare({ taskId: "t_1", grants: GRANTS, git: GIT, deviceTtlMs: null });
    addDevice(share.id, { did: "gdv_a", label: "Alice", ip: "1.2.3.4" });
    // Forge a cookie claiming a different task than the share's.
    const { token } = signGuestSession({ shareId: share.id, taskId: "t_EVIL", did: "gdv_a", deviceTtlMs: null });
    expect(verifyRequestActor(fakeReq(token))).toBeNull();
  });
});
