import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import {
  addDevice,
  createShare,
  deleteShare,
  findValidDevice,
  getShare,
  isShareUsable,
  listShares,
  revokeDevice,
  revokeShare,
  updateShare,
  verifyShareToken,
  _internal,
  _resetForTests,
  type ShareGit,
  type ShareGrants,
} from "../shareStore";

const { SHARES_FILE } = _internal;

// shareStore binds its file path to the real `.bridge-state` dir; snapshot
// and restore so a developer's live shares aren't disturbed by the suite.
let saved: string | null = null;

const GRANTS: ShareGrants = {
  sendMessage: true,
  spawnAgent: false,
  answerPermission: false,
  commit: false,
  push: false,
};
const GIT: ShareGit = { branchMode: "auto-create", autoCommit: true, autoPush: false };

beforeEach(() => {
  saved = existsSync(SHARES_FILE) ? readFileSync(SHARES_FILE, "utf8") : null;
  _resetForTests();
  rmSync(SHARES_FILE, { force: true });
});

afterEach(() => {
  if (saved !== null) writeFileSync(SHARES_FILE, saved, "utf8");
  else rmSync(SHARES_FILE, { force: true });
  _resetForTests();
});

describe("createShare", () => {
  it("returns the raw token once and stores only its hash", () => {
    const { share, token } = createShare({ taskId: "t_1", grants: GRANTS, git: GIT });
    expect(token).toBeTruthy();
    expect(share.tokenHash).toBe(_internal.sha256Hex(token));
    // The persisted file must not contain the raw token anywhere.
    expect(readFileSync(SHARES_FILE, "utf8")).not.toContain(token);
  });

  it("normalizes grants so push implies commit", () => {
    const { share } = createShare({
      taskId: "t_1",
      grants: { ...GRANTS, commit: false, push: true },
      git: GIT,
    });
    expect(share.grants.commit).toBe(true);
    expect(share.grants.push).toBe(true);
  });

  it("drops a branchName unless branchMode is fixed", () => {
    const { share } = createShare({
      taskId: "t_1",
      grants: GRANTS,
      git: { branchMode: "auto-create", branchName: "ignored", autoCommit: true, autoPush: false },
    });
    expect(share.git.branchName).toBeUndefined();
    const { share: fixed } = createShare({
      taskId: "t_1",
      grants: GRANTS,
      git: { branchMode: "fixed", branchName: "feature/x", autoCommit: true, autoPush: false },
    });
    expect(fixed.git.branchName).toBe("feature/x");
  });
});

describe("verifyShareToken", () => {
  it("accepts the right token, rejects a wrong one", () => {
    const { share, token } = createShare({ taskId: "t_1", grants: GRANTS, git: GIT });
    expect(verifyShareToken(share.id, token)).toBe(true);
    expect(verifyShareToken(share.id, token + "x")).toBe(false);
    expect(verifyShareToken("shr_nope", token)).toBe(false);
    expect(verifyShareToken(share.id, "")).toBe(false);
  });
});

describe("isShareUsable", () => {
  it("is false when revoked or past hard expiry", () => {
    const { share } = createShare({ taskId: "t_1", grants: GRANTS, git: GIT });
    expect(isShareUsable(share)).toBe(true);
    expect(isShareUsable({ ...share, revoked: true })).toBe(false);
    expect(isShareUsable({ ...share, expiresAt: Date.now() - 1 })).toBe(false);
    expect(isShareUsable({ ...share, expiresAt: Date.now() + 10_000 })).toBe(true);
  });
});

describe("devices", () => {
  it("adds a device with TTL-derived expiry and finds it while valid", () => {
    const { share } = createShare({
      taskId: "t_1",
      grants: GRANTS,
      git: GIT,
      deviceTtlMs: 60_000,
    });
    const dev = addDevice(share.id, { did: "gdv_a", label: "Alice", ip: "1.2.3.4" });
    expect(dev?.expiresAt).toBeGreaterThan(Date.now());
    const found = getShare(share.id)!;
    expect(findValidDevice(found, "gdv_a")).not.toBeNull();
    expect(findValidDevice(found, "gdv_missing")).toBeNull();
  });

  it("treats an expired device as invalid", () => {
    const { share } = createShare({ taskId: "t_1", grants: GRANTS, git: GIT, deviceTtlMs: 1 });
    addDevice(share.id, { did: "gdv_a", label: "Alice", ip: "1.2.3.4" });
    const found = getShare(share.id)!;
    // expiresAt = now + 1ms; a moment later it's expired.
    expect(findValidDevice(found, "gdv_a", Date.now() + 1000)).toBeNull();
  });

  it("null deviceTtlMs means the device never expires", () => {
    const { share } = createShare({ taskId: "t_1", grants: GRANTS, git: GIT, deviceTtlMs: null });
    addDevice(share.id, { did: "gdv_a", label: "Alice", ip: "1.2.3.4" });
    const found = getShare(share.id)!;
    expect(findValidDevice(found, "gdv_a", Date.now() + 1e12)).not.toBeNull();
  });

  it("revokes a single device", () => {
    const { share } = createShare({ taskId: "t_1", grants: GRANTS, git: GIT });
    addDevice(share.id, { did: "gdv_a", label: "Alice", ip: "1.2.3.4" });
    expect(revokeDevice(share.id, "gdv_a")).toBe(true);
    expect(findValidDevice(getShare(share.id)!, "gdv_a")).toBeNull();
  });

  it("re-adding the same did refreshes rather than duplicates", () => {
    const { share } = createShare({ taskId: "t_1", grants: GRANTS, git: GIT });
    addDevice(share.id, { did: "gdv_a", label: "Alice", ip: "1.1.1.1" });
    addDevice(share.id, { did: "gdv_a", label: "Alice2", ip: "2.2.2.2" });
    const found = getShare(share.id)!;
    expect(found.devices.filter((d) => d.did === "gdv_a")).toHaveLength(1);
    expect(found.devices[0].label).toBe("Alice2");
  });
});

describe("update / revoke / delete / list", () => {
  it("updates grants and git and revokes", () => {
    const { share } = createShare({ taskId: "t_1", grants: GRANTS, git: GIT });
    updateShare(share.id, { grants: { answerPermission: true }, revoked: false });
    expect(getShare(share.id)!.grants.answerPermission).toBe(true);
    expect(revokeShare(share.id)).toBe(true);
    expect(getShare(share.id)!.revoked).toBe(true);
  });

  it("lists by task and deletes", () => {
    const a = createShare({ taskId: "t_1", grants: GRANTS, git: GIT }).share;
    createShare({ taskId: "t_2", grants: GRANTS, git: GIT });
    expect(listShares("t_1")).toHaveLength(1);
    expect(listShares()).toHaveLength(2);
    expect(deleteShare(a.id)).toBe(true);
    expect(listShares("t_1")).toHaveLength(0);
  });
});

describe("persistence", () => {
  it("survives a reload from disk", () => {
    const { share, token } = createShare({ taskId: "t_1", grants: GRANTS, git: GIT });
    // Simulate a fresh process: drop the in-memory cache, force a reload.
    _resetForTestsKeepFile();
    expect(getShare(share.id)?.taskId).toBe("t_1");
    expect(verifyShareToken(share.id, token)).toBe(true);
  });
});

// Helper: clear the loaded flag WITHOUT wiping the file, to exercise the
// disk-reload path. We can't import the private `state`, so we re-trigger
// load by deleting the module-level cache via _resetForTests + re-reading
// the file the store just wrote. Implemented by re-importing is overkill;
// instead we rely on the store re-reading because _resetForTests sets an
// empty in-memory copy with loaded=true. To truly test reload we bypass:
function _resetForTestsKeepFile(): void {
  // Re-load from disk by toggling the global cache. Access the same
  // globalThis stash the store uses.
  const g = globalThis as unknown as {
    __bridgeShareStore?: { data: { shares: unknown[] }; loaded: boolean };
  };
  if (g.__bridgeShareStore) {
    g.__bridgeShareStore.data = { shares: [] };
    g.__bridgeShareStore.loaded = false;
  }
}
