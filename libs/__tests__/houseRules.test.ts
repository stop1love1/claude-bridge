import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * houseRules reads from `BRIDGE_LOGIC_DIR/house-rules.md` (global) and
 * `<appPath>/.bridge/house-rules.md` (per-app). The global path is
 * computed at module import time from `BRIDGE_ROOT`, which itself is
 * `process.cwd()`. We mock `process.cwd()` (no real chdir — the spy
 * just changes the return value) BEFORE importing the module so the
 * fresh import resolves `BRIDGE_LOGIC_DIR` against our temp dir
 * without touching the real `prompts/` directory.
 */
function mktmp(label: string): string {
  return mkdtempSync(join(tmpdir(), `bridge-houserules-${label}-`));
}

describe("houseRules", () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = mktmp("global");
    vi.spyOn(process, "cwd").mockReturnValue(tmpRoot);
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("returns null when no files exist", async () => {
    const { loadHouseRules, loadGlobalHouseRules, loadAppHouseRules } =
      await import("../houseRules");
    expect(loadGlobalHouseRules()).toBeNull();
    expect(loadAppHouseRules(tmpRoot)).toBeNull();
    expect(loadHouseRules(null)).toBeNull();
    expect(loadHouseRules(tmpRoot)).toBeNull();
  });

  it("loads only the global file when no per-app file exists", async () => {
    mkdirSync(join(tmpRoot, "prompts"), { recursive: true });
    writeFileSync(
      join(tmpRoot, "prompts", "house-rules.md"),
      "- Prefer named exports.\n- No emojis in code.",
    );
    const { loadHouseRules } = await import("../houseRules");
    const out = loadHouseRules("/nonexistent/app");
    expect(out).toContain("### Global");
    expect(out).toContain("Prefer named exports");
    expect(out).not.toContain("### App-specific");
  });

  it("loads only the per-app file when no global file exists", async () => {
    const appDir = mktmp("app");
    mkdirSync(join(appDir, ".bridge"), { recursive: true });
    writeFileSync(join(appDir, ".bridge", "house-rules.md"), "- App-only rule.");
    try {
      const { loadHouseRules } = await import("../houseRules");
      const out = loadHouseRules(appDir);
      expect(out).toContain("### App-specific");
      expect(out).toContain("App-only rule");
      expect(out).not.toContain("### Global");
    } finally {
      rmSync(appDir, { recursive: true, force: true });
    }
  });

  it("merges global before per-app with a separator", async () => {
    mkdirSync(join(tmpRoot, "prompts"), { recursive: true });
    writeFileSync(join(tmpRoot, "prompts", "house-rules.md"), "GLOBAL CONTENT");
    const appDir = mktmp("app2");
    mkdirSync(join(appDir, ".bridge"), { recursive: true });
    writeFileSync(join(appDir, ".bridge", "house-rules.md"), "APP CONTENT");
    try {
      const { loadHouseRules } = await import("../houseRules");
      const out = loadHouseRules(appDir);
      expect(out).not.toBeNull();
      const globalIdx = out!.indexOf("GLOBAL CONTENT");
      const sepIdx = out!.indexOf("---", globalIdx);
      const appIdx = out!.indexOf("APP CONTENT");
      expect(globalIdx).toBeGreaterThan(-1);
      expect(sepIdx).toBeGreaterThan(globalIdx);
      expect(appIdx).toBeGreaterThan(sepIdx);
    } finally {
      rmSync(appDir, { recursive: true, force: true });
    }
  });

  it("treats whitespace-only files as missing", async () => {
    mkdirSync(join(tmpRoot, "prompts"), { recursive: true });
    writeFileSync(join(tmpRoot, "prompts", "house-rules.md"), "   \n\n  ");
    const { loadHouseRules } = await import("../houseRules");
    expect(loadHouseRules(null)).toBeNull();
  });

  it("returns null for empty/falsy app paths", async () => {
    const { loadAppHouseRules } = await import("../houseRules");
    expect(loadAppHouseRules("")).toBeNull();
  });
});
