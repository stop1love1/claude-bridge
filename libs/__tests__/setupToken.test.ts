import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

/**
 * setupToken.ts derives `SETUP_TOKEN_FILE` from `BRIDGE_STATE_DIR`,
 * which itself derives from `process.cwd()`. Each test redirects cwd
 * to a fresh temp dir, then re-imports the module so the constant
 * picks up the new path.
 */
let tempCwd: string;

beforeEach(() => {
  tempCwd = mkdtempSync(join(tmpdir(), "bridge-setup-test-"));
  vi.spyOn(process, "cwd").mockReturnValue(tempCwd);
  vi.resetModules();
});

afterEach(() => {
  vi.restoreAllMocks();
  try {
    rmSync(tempCwd, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

describe("ensureSetupToken", () => {
  it("creates the token file on first call and reuses it on second", async () => {
    const { ensureSetupToken, SETUP_TOKEN_PATH } = await import("../setupToken");
    const a = ensureSetupToken();
    expect(typeof a).toBe("string");
    expect(a.length).toBeGreaterThan(20);
    expect(SETUP_TOKEN_PATH.startsWith(tempCwd)).toBe(true);

    // Idempotent within one boot — same module instance.
    const b = ensureSetupToken();
    expect(b).toBe(a);
  });

  it("regenerates when the file is unreadable / missing content", async () => {
    const { ensureSetupToken, SETUP_TOKEN_PATH } = await import("../setupToken");
    const first = ensureSetupToken();
    // Empty out the file — `ensureSetupToken` should mint a new value
    // because the cached read returned an empty string.
    writeFileSync(SETUP_TOKEN_PATH, "");
    const second = ensureSetupToken();
    expect(second).not.toBe(first);
    expect(second.length).toBeGreaterThan(20);
  });
});

describe("verifySetupToken", () => {
  it("accepts the freshly-minted token", async () => {
    const { ensureSetupToken, verifySetupToken } = await import("../setupToken");
    const token = ensureSetupToken();
    expect(verifySetupToken(token)).toBe(true);
  });

  it("rejects a wrong-prefix token of the same length", async () => {
    const { ensureSetupToken, verifySetupToken } = await import("../setupToken");
    const token = ensureSetupToken();
    const tampered = "x".repeat(token.length);
    expect(verifySetupToken(tampered)).toBe(false);
  });

  it("rejects length-mismatched inputs without comparing", async () => {
    const { ensureSetupToken, verifySetupToken } = await import("../setupToken");
    const token = ensureSetupToken();
    expect(verifySetupToken(token + "x")).toBe(false);
    expect(verifySetupToken(token.slice(0, -1))).toBe(false);
  });

  it("rejects empty / non-string / null inputs", async () => {
    const { ensureSetupToken, verifySetupToken } = await import("../setupToken");
    ensureSetupToken();
    expect(verifySetupToken("")).toBe(false);
    expect(verifySetupToken(null)).toBe(false);
    expect(verifySetupToken(undefined)).toBe(false);
    expect(verifySetupToken(42)).toBe(false);
    expect(verifySetupToken({})).toBe(false);
  });

  it("returns false when no token file exists at all", async () => {
    const { verifySetupToken } = await import("../setupToken");
    // Without a prior `ensureSetupToken()` the file is absent.
    expect(verifySetupToken("anything")).toBe(false);
  });
});

describe("clearSetupToken / hasSetupToken", () => {
  it("hasSetupToken flips to false after clearSetupToken", async () => {
    const { ensureSetupToken, clearSetupToken, hasSetupToken } = await import(
      "../setupToken"
    );
    ensureSetupToken();
    expect(hasSetupToken()).toBe(true);
    clearSetupToken();
    expect(hasSetupToken()).toBe(false);
  });

  it("clearSetupToken is idempotent on a missing file", async () => {
    const { clearSetupToken } = await import("../setupToken");
    // Should not throw.
    expect(() => {
      clearSetupToken();
      clearSetupToken();
    }).not.toThrow();
  });

  it("verifySetupToken returns false after clear", async () => {
    const { ensureSetupToken, clearSetupToken, verifySetupToken } = await import(
      "../setupToken"
    );
    const token = ensureSetupToken();
    clearSetupToken();
    expect(verifySetupToken(token)).toBe(false);
  });
});
