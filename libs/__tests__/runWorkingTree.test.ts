import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";
import { isUnderAppRoot, resolveRunCwd } from "../runWorkingTree";
import { BRIDGE_ROOT } from "../paths";
import { DEFAULT_GIT_SETTINGS, type App } from "../apps";
import type { Run } from "../meta";

describe("isUnderAppRoot", () => {
  it("accepts a path inside the app root", () => {
    expect(isUnderAppRoot("/repo/app", "/repo/app/.worktrees/x")).toBe(true);
  });

  it("accepts the app root itself", () => {
    expect(isUnderAppRoot("/repo/app", "/repo/app")).toBe(true);
  });

  it("rejects a sibling directory that merely shares the app root as a string prefix", () => {
    expect(isUnderAppRoot("/repo/app", "/repo/app-evil")).toBe(false);
  });

  it("rejects traversal back out of the app root", () => {
    expect(isUnderAppRoot("/repo/app", "/repo/app/../other")).toBe(false);
  });

  it("rejects an unrelated absolute path", () => {
    expect(isUnderAppRoot("/repo/app", "/etc")).toBe(false);
  });

  it("does not case-fold on Windows (documented limitation, not changed by this extraction)", () => {
    if (process.platform !== "win32") return;
    expect(isUnderAppRoot("C:\\repo\\app", "C:\\REPO\\APP\\evil")).toBe(false);
  });
});

describe("resolveRunCwd", () => {
  let appDir: string;

  beforeEach(() => {
    appDir = mkdtempSync(join(tmpdir(), "bridge-runworkingtree-app-"));
  });

  afterEach(() => {
    rmSync(appDir, { recursive: true, force: true });
  });

  function makeApp(overrides: Partial<App> = {}): App {
    return {
      name: "fixture-app",
      path: appDir,
      rawPath: appDir,
      description: "",
      git: DEFAULT_GIT_SETTINGS,
      verify: {},
      pinnedFiles: [],
      symbolDirs: [],
      quality: {},
      retry: {},
      memory: {},
      dispatch: {},
      capabilities: [],
      ...overrides,
    } as App;
  }

  function makeRun(overrides: Partial<Run> = {}): Run {
    return {
      sessionId: "s1",
      role: "coordinator",
      repo: "fixture-app",
      status: "running",
      startedAt: null,
      endedAt: null,
      ...overrides,
    } as Run;
  }

  it("prefers an existing worktree that is under the app root", () => {
    const worktreeDir = join(appDir, ".worktrees", "x");
    mkdirSync(worktreeDir, { recursive: true });
    const app = makeApp();
    const run = makeRun({ worktreePath: worktreeDir });
    expect(resolveRunCwd(run, app)).toBe(worktreeDir);
  });

  it("falls back to app.path when worktreePath escapes the app root", () => {
    const evilDir = `${appDir}-evil`;
    mkdirSync(evilDir, { recursive: true });
    try {
      const app = makeApp();
      const run = makeRun({ worktreePath: evilDir });
      expect(resolveRunCwd(run, app)).toBe(appDir);
    } finally {
      rmSync(evilDir, { recursive: true, force: true });
    }
  });

  it("falls back to app.path when worktreePath is under the root but missing on disk", () => {
    const missingWorktree = join(appDir, ".worktrees", "gone");
    const app = makeApp();
    const run = makeRun({ worktreePath: missingWorktree });
    expect(resolveRunCwd(run, app)).toBe(appDir);
  });

  it("falls back to app.path when the run has no worktreePath", () => {
    const app = makeApp();
    const run = makeRun({ worktreePath: null });
    expect(resolveRunCwd(run, app)).toBe(appDir);
  });

  it("falls back to the BRIDGE.md-resolved cwd when there is no app", () => {
    const run = makeRun({ repo: basename(BRIDGE_ROOT), worktreePath: null });
    expect(resolveRunCwd(run, null)).toBe(BRIDGE_ROOT);
  });

  it("returns null when nothing resolves", () => {
    const run = makeRun({ repo: "no-such-repo-xyz", worktreePath: null });
    expect(resolveRunCwd(run, null)).toBeNull();
  });
});
