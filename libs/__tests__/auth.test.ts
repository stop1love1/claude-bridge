import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Auth tests run against a temp `~/.claude/bridge.json` so the operator's
 * real credentials are never touched. We point `homedir()` at a fresh
 * temp dir per test, write a synthetic auth config, then re-import the
 * auth module so it picks up the redirected dir.
 */

let tempHome: string;
let originalHome: string | undefined;

function writeAuthConfig(payload: object): void {
  const claudeDir = join(tempHome, ".claude");
  mkdirSync(claudeDir, { recursive: true });
  writeFileSync(join(claudeDir, "bridge.json"), JSON.stringify(payload), "utf8");
}

beforeEach(() => {
  tempHome = mkdtempSync(join(tmpdir(), "bridge-auth-test-"));
  originalHome = process.env.HOME;
  process.env.HOME = tempHome;
  process.env.USERPROFILE = tempHome;
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  vi.spyOn(require("node:os"), "homedir").mockReturnValue(tempHome);
  vi.resetModules();
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

describe("constantTimeStringEqual", () => {
  it("returns true for identical non-empty strings", async () => {
    const { constantTimeStringEqual } = await import("../auth");
    expect(constantTimeStringEqual("abc123", "abc123")).toBe(true);
    expect(constantTimeStringEqual("x".repeat(64), "x".repeat(64))).toBe(true);
  });

  it("returns false on any length mismatch", async () => {
    const { constantTimeStringEqual } = await import("../auth");
    expect(constantTimeStringEqual("abc", "abcd")).toBe(false);
    expect(constantTimeStringEqual("abcd", "abc")).toBe(false);
  });

  it("returns false on equal-length mismatch", async () => {
    const { constantTimeStringEqual } = await import("../auth");
    expect(constantTimeStringEqual("abcdef", "abcdeg")).toBe(false);
    expect(constantTimeStringEqual("abcdef", "Abcdef")).toBe(false);
  });

  it("returns false for null / undefined / non-string inputs", async () => {
    const { constantTimeStringEqual } = await import("../auth");
    expect(constantTimeStringEqual(null, "x")).toBe(false);
    expect(constantTimeStringEqual("x", null)).toBe(false);
    expect(constantTimeStringEqual(undefined, "x")).toBe(false);
    expect(constantTimeStringEqual(undefined, undefined)).toBe(false);
    expect(
      constantTimeStringEqual(123 as unknown as string, "x"),
    ).toBe(false);
  });

  it("returns false when either side is empty", async () => {
    const { constantTimeStringEqual } = await import("../auth");
    expect(constantTimeStringEqual("", "")).toBe(false);
    expect(constantTimeStringEqual("", "abc")).toBe(false);
    expect(constantTimeStringEqual("abc", "")).toBe(false);
  });

  it("handles multibyte UTF-8 without crashing", async () => {
    const { constantTimeStringEqual } = await import("../auth");
    expect(constantTimeStringEqual("café", "café")).toBe(true);
    // Same Unicode length, different byte length — must reject.
    expect(constantTimeStringEqual("café", "cafe")).toBe(false);
  });
});

describe("verifyRequestAuthOrInternal — internal token path", () => {
  function fakeReq(opts: {
    cookie?: string;
    internalHeader?: string | null;
  }): { cookies: { get(name: string): { value: string } | undefined }; headers: { get(name: string): string | null } } {
    return {
      cookies: {
        get: (name: string) =>
          opts.cookie && name === "bridge_session"
            ? { value: opts.cookie }
            : undefined,
      },
      headers: {
        get: (name: string) =>
          name.toLowerCase() === "x-bridge-internal-token"
            ? opts.internalHeader ?? null
            : null,
      },
    };
  }

  it("accepts a request bearing the exact internal token", async () => {
    writeAuthConfig({
      auth: {
        email: "op@example.com",
        passwordHash: "scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAA==",
        secret: "test-secret",
        internalToken: "abc-token-1234567890",
        trustedDevices: [],
      },
    });
    const { verifyRequestAuthOrInternal } = await import("../auth");
    const out = verifyRequestAuthOrInternal(
      fakeReq({ internalHeader: "abc-token-1234567890" }),
    );
    expect(out).not.toBeNull();
    expect(out?.sub).toBe("op@example.com");
  });

  it("rejects a wrong-prefix token of the same length", async () => {
    writeAuthConfig({
      auth: {
        email: "op@example.com",
        passwordHash: "scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAA==",
        secret: "test-secret",
        internalToken: "abc-token-1234567890",
        trustedDevices: [],
      },
    });
    const { verifyRequestAuthOrInternal } = await import("../auth");
    const out = verifyRequestAuthOrInternal(
      fakeReq({ internalHeader: "xyz-token-1234567890" }),
    );
    expect(out).toBeNull();
  });

  it("rejects a length-mismatched token", async () => {
    writeAuthConfig({
      auth: {
        email: "op@example.com",
        passwordHash: "scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAA==",
        secret: "test-secret",
        internalToken: "abc-token-1234567890",
        trustedDevices: [],
      },
    });
    const { verifyRequestAuthOrInternal } = await import("../auth");
    expect(
      verifyRequestAuthOrInternal(fakeReq({ internalHeader: "abc" })),
    ).toBeNull();
    expect(
      verifyRequestAuthOrInternal(
        fakeReq({ internalHeader: "abc-token-1234567890-extra" }),
      ),
    ).toBeNull();
  });

  it("rejects when no header AND no cookie", async () => {
    writeAuthConfig({
      auth: {
        email: "op@example.com",
        passwordHash: "scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAA==",
        secret: "test-secret",
        internalToken: "abc-token-1234567890",
        trustedDevices: [],
      },
    });
    const { verifyRequestAuthOrInternal } = await import("../auth");
    expect(
      verifyRequestAuthOrInternal(fakeReq({ internalHeader: null })),
    ).toBeNull();
  });

  it("rejects when auth is not configured at all", async () => {
    // No bridge.json written.
    const { verifyRequestAuthOrInternal } = await import("../auth");
    expect(
      verifyRequestAuthOrInternal(fakeReq({ internalHeader: "anything" })),
    ).toBeNull();
  });

  it("rejects when internalToken is empty in config", async () => {
    writeAuthConfig({
      auth: {
        email: "op@example.com",
        passwordHash: "scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAA==",
        secret: "test-secret",
        internalToken: "",
        trustedDevices: [],
      },
    });
    const { verifyRequestAuthOrInternal } = await import("../auth");
    // Empty token plus empty header must NOT authenticate — that would
    // be a default-allow trap on misconfigured installs.
    expect(
      verifyRequestAuthOrInternal(fakeReq({ internalHeader: "" })),
    ).toBeNull();
  });
});
