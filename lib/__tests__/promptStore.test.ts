import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Run } from "../meta";

/**
 * Same temp-dir + cwd-spy pattern as houseRules / playbooks tests:
 * point process.cwd() at a fresh temp dir BEFORE importing the module
 * so SESSIONS_DIR resolves into our fixture instead of the real
 * sessions/ folder under the bridge.
 */
function mktmp(): string {
  return mkdtempSync(join(tmpdir(), "bridge-promptstore-"));
}

const baseRun: Run = {
  sessionId: "11111111-1111-1111-1111-111111111111",
  role: "coder",
  repo: "app-web",
  status: "failed",
  startedAt: null,
  endedAt: null,
  parentSessionId: "00000000-0000-0000-0000-000000000000",
};

describe("readOriginalPrompt", () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = mktmp();
    vi.spyOn(process, "cwd").mockReturnValue(tmpRoot);
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("returns empty string when sessions dir is missing", async () => {
    const { readOriginalPrompt } = await import("../promptStore");
    expect(readOriginalPrompt("t_20260426_001", baseRun)).toBe("");
  });

  it("returns empty string when no matching prompt file exists", async () => {
    mkdirSync(join(tmpRoot, "sessions", "t_20260426_001"), { recursive: true });
    const { readOriginalPrompt } = await import("../promptStore");
    expect(readOriginalPrompt("t_20260426_001", baseRun)).toBe("");
  });

  it("loads the matching <role>-<repo>.prompt.txt", async () => {
    const dir = join(tmpRoot, "sessions", "t_20260426_001");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "coder-app-web.prompt.txt"),
      "ORIGINAL PROMPT BODY",
    );
    const { readOriginalPrompt } = await import("../promptStore");
    expect(readOriginalPrompt("t_20260426_001", baseRun)).toBe(
      "ORIGINAL PROMPT BODY",
    );
  });

  it("picks the newest file when several match the role prefix", async () => {
    const dir = join(tmpRoot, "sessions", "t_20260426_001");
    mkdirSync(dir, { recursive: true });
    const oldPath = join(dir, "coder-app-web.prompt.txt");
    const newPath = join(dir, "coder-app-api.prompt.txt");
    writeFileSync(oldPath, "OLD");
    writeFileSync(newPath, "NEW");
    // Force the older mtime to actually be older.
    const past = new Date(Date.now() - 60_000);
    utimesSync(oldPath, past, past);
    const { readOriginalPrompt } = await import("../promptStore");
    expect(readOriginalPrompt("t_20260426_001", baseRun)).toBe("NEW");
  });

  it("ignores files that don't start with `<role>-`", async () => {
    const dir = join(tmpRoot, "sessions", "t_20260426_001");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "reviewer-app-web.prompt.txt"), "WRONG");
    const { readOriginalPrompt } = await import("../promptStore");
    expect(readOriginalPrompt("t_20260426_001", baseRun)).toBe("");
  });
});
