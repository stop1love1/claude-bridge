import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";

/**
 * paths.ts captures `process.cwd()` and `homedir()` at module load
 * time, so each test redirects both then re-imports the module.
 */
let tempCwd: string;
let originalEnv: NodeJS.ProcessEnv;

beforeEach(() => {
  tempCwd = mkdtempSync(join(tmpdir(), "bridge-paths-test-"));
  originalEnv = { ...process.env };
  vi.spyOn(process, "cwd").mockReturnValue(tempCwd);
  vi.resetModules();
});

afterEach(() => {
  vi.restoreAllMocks();
  process.env = originalEnv;
  try {
    rmSync(tempCwd, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

describe("BRIDGE_ROOT / BRIDGE_FOLDER", () => {
  it("BRIDGE_ROOT resolves to process.cwd()", async () => {
    const { BRIDGE_ROOT } = await import("../paths");
    // resolve() may normalize Windows drive case; compare case-insensitively.
    expect(BRIDGE_ROOT.toLowerCase()).toBe(tempCwd.toLowerCase());
  });

  it("BRIDGE_FOLDER is the basename of cwd", async () => {
    const { BRIDGE_FOLDER } = await import("../paths");
    expect(BRIDGE_FOLDER.length).toBeGreaterThan(0);
    expect(tempCwd.toLowerCase().endsWith(BRIDGE_FOLDER.toLowerCase())).toBe(true);
  });

  it("USER_CLAUDE_DIR points at $HOME/.claude", async () => {
    const { USER_CLAUDE_DIR } = await import("../paths");
    expect(USER_CLAUDE_DIR.toLowerCase()).toBe(
      join(homedir(), ".claude").toLowerCase(),
    );
  });
});

describe("readBridgeMd", () => {
  it("returns file contents when present", async () => {
    writeFileSync(join(tempCwd, "BRIDGE.md"), "# Bridge\nhello");
    const { readBridgeMd } = await import("../paths");
    expect(readBridgeMd()).toContain("# Bridge");
  });

  it("returns empty string when file missing", async () => {
    const { readBridgeMd } = await import("../paths");
    expect(readBridgeMd()).toBe("");
  });
});

describe("BRIDGE_PORT", () => {
  it("uses BRIDGE_PORT env when set", async () => {
    process.env.BRIDGE_PORT = "9090";
    delete process.env.PORT;
    vi.resetModules();
    const { BRIDGE_PORT } = await import("../paths");
    expect(BRIDGE_PORT).toBe(9090);
  });

  it("falls back to PORT when BRIDGE_PORT is absent", async () => {
    delete process.env.BRIDGE_PORT;
    process.env.PORT = "8181";
    vi.resetModules();
    const { BRIDGE_PORT } = await import("../paths");
    expect(BRIDGE_PORT).toBe(8181);
  });

  it("defaults to 7777 when neither is set", async () => {
    delete process.env.BRIDGE_PORT;
    delete process.env.PORT;
    vi.resetModules();
    const { BRIDGE_PORT } = await import("../paths");
    expect(BRIDGE_PORT).toBe(7777);
  });
});

describe("getPublicBridgeUrl", () => {
  it("strips a trailing slash from BRIDGE_PUBLIC_URL", async () => {
    process.env.BRIDGE_PUBLIC_URL = "https://example.com/";
    vi.resetModules();
    const { getPublicBridgeUrl } = await import("../paths");
    expect(getPublicBridgeUrl()).toBe("https://example.com");
  });

  it("falls back to BRIDGE_URL env when BRIDGE_PUBLIC_URL absent", async () => {
    delete process.env.BRIDGE_PUBLIC_URL;
    process.env.BRIDGE_URL = "https://bridge.local:7777/";
    vi.resetModules();
    const { getPublicBridgeUrl } = await import("../paths");
    expect(getPublicBridgeUrl()).toBe("https://bridge.local:7777");
  });

  it("falls back to localhost on the configured port as last resort", async () => {
    delete process.env.BRIDGE_PUBLIC_URL;
    delete process.env.BRIDGE_URL;
    delete process.env.PORT;
    process.env.BRIDGE_PORT = "7777";
    vi.resetModules();
    const { getPublicBridgeUrl } = await import("../paths");
    expect(getPublicBridgeUrl()).toBe("http://localhost:7777");
  });
});
