import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createWorktreeForRun,
  inheritWorktreeFields,
  pruneStaleWorktrees,
  removeWorktree,
  worktreePathFor,
} from "../worktrees";
import type { AppGitSettings } from "../apps";

const SETTINGS: AppGitSettings = {
  branchMode: "auto-create",
  fixedBranch: "",
  autoCommit: false,
  autoPush: false,
  worktreeMode: "enabled",
};

function gitInit(dir: string): void {
  execFileSync("git", ["init", "-b", "main"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "wt@test.local"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "wt-test"], { cwd: dir, stdio: "ignore" });
  writeFileSync(join(dir, "README.md"), "# tmp\n");
  execFileSync("git", ["add", "."], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "init"], { cwd: dir, stdio: "ignore" });
}

describe("worktreePathFor", () => {
  it("places the worktree under <appPath>/.worktrees/<sessionId>", () => {
    const p = worktreePathFor("/abs/app", "abc-123");
    expect(p).toBe(join("/abs/app", ".worktrees", "abc-123"));
  });
});

describe("inheritWorktreeFields", () => {
  it("returns nulls when parent has no worktree fields", () => {
    expect(inheritWorktreeFields({})).toEqual({
      worktreePath: null,
      worktreeBranch: null,
      worktreeBaseBranch: null,
    });
  });

  it("propagates all three fields when set", () => {
    expect(
      inheritWorktreeFields({
        worktreePath: "/abs/.worktrees/abc",
        worktreeBranch: "claude/wt/t1",
        worktreeBaseBranch: "main",
      }),
    ).toEqual({
      worktreePath: "/abs/.worktrees/abc",
      worktreeBranch: "claude/wt/t1",
      worktreeBaseBranch: "main",
    });
  });
});

// Skip the integration tests if git isn't available — keeps the suite
// runnable on minimal CI.
let gitAvailable = false;
try {
  execFileSync("git", ["--version"], { stdio: "ignore" });
  gitAvailable = true;
} catch { /* skip */ }

const integration = gitAvailable ? describe : describe.skip;

integration("createWorktreeForRun + removeWorktree (real git)", () => {
  let appPath: string;

  beforeEach(() => {
    appPath = mkdtempSync(join(tmpdir(), "bridge-wt-"));
    gitInit(appPath);
  });

  afterEach(() => {
    try { rmSync(appPath, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("creates a worktree on a fresh per-spawn branch and reports baseBranch", async () => {
    const handle = await createWorktreeForRun({
      appPath,
      settings: SETTINGS,
      taskId: "t_test_001",
      sessionId: "11111111-1111-1111-1111-111111111111",
    });
    expect(handle).not.toBeNull();
    expect(handle!.path).toBe(worktreePathFor(appPath, "11111111-1111-1111-1111-111111111111"));
    expect(existsSync(handle!.path)).toBe(true);
    // Spawn branch is always unique (per-task + per-session) so two
    // concurrent spawns / branchMode=fixed against an already-checked-out
    // branch don't collide. Base branch reflects the merge target —
    // for `auto-create` mode that's `claude/<taskId>` (auto-materialized
    // from current HEAD on first use).
    expect(handle!.branch).toMatch(/^claude\/wt\/t_test_001-/);
    expect(handle!.baseBranch).toBe("claude/t_test_001");
  });

  it("forks from fixedBranch when branchMode=fixed and the branch is already checked out in the live tree", async () => {
    // Live tree is on `main` (default from gitInit). Worktree mode +
    // branchMode=fixed pointing at `main` previously crashed with
    // `fatal: 'main' is already checked out`. The fix mints a per-spawn
    // branch and forks it from `main`, leaving the live tree alone.
    const fixedSettings: AppGitSettings = {
      ...SETTINGS,
      branchMode: "fixed",
      fixedBranch: "main",
    };
    const handle = await createWorktreeForRun({
      appPath,
      settings: fixedSettings,
      taskId: "t_test_fixed",
      sessionId: "77777777-7777-7777-7777-777777777777",
    });
    expect(handle).not.toBeNull();
    expect(handle!.branch).toMatch(/^claude\/wt\/t_test_fixed-/);
    expect(handle!.baseBranch).toBe("main");
  });

  it("two concurrent auto-create spawns mint distinct spawn branches", async () => {
    const a = await createWorktreeForRun({
      appPath,
      settings: SETTINGS,
      taskId: "t_test_concurrent",
      sessionId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
    });
    const b = await createWorktreeForRun({
      appPath,
      settings: SETTINGS,
      taskId: "t_test_concurrent",
      sessionId: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
    });
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(a!.branch).not.toBe(b!.branch);
    // They should fork from the same auto-created base.
    expect(a!.baseBranch).toBe("claude/t_test_concurrent");
    expect(b!.baseBranch).toBe("claude/t_test_concurrent");
  });

  it("refuses to clobber an existing worktree dir", async () => {
    const sid = "22222222-2222-2222-2222-222222222222";
    const wt = worktreePathFor(appPath, sid);
    mkdirSync(wt, { recursive: true });
    const handle = await createWorktreeForRun({
      appPath,
      settings: SETTINGS,
      taskId: "t_test_002",
      sessionId: sid,
    });
    expect(handle).toBeNull();
  });

  it("removes a created worktree cleanly", async () => {
    const handle = await createWorktreeForRun({
      appPath,
      settings: SETTINGS,
      taskId: "t_test_003",
      sessionId: "33333333-3333-3333-3333-333333333333",
    });
    expect(handle).not.toBeNull();
    const r = await removeWorktree({ appPath, worktreePath: handle!.path });
    expect(r.ok).toBe(true);
    expect(existsSync(handle!.path)).toBe(false);
  });

  it("removeWorktree is idempotent on already-deleted paths", async () => {
    const sid = "44444444-4444-4444-4444-444444444444";
    const path = worktreePathFor(appPath, sid);
    const r = await removeWorktree({ appPath, worktreePath: path });
    expect(r.ok).toBe(true);
  });

  it("removeWorktree refuses paths outside the app root", async () => {
    const r = await removeWorktree({
      appPath,
      worktreePath: join(tmpdir(), "outside"),
    });
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/outside/);
  });

  it("pruneStaleWorktrees reaps directories older than the cutoff", async () => {
    const handle = await createWorktreeForRun({
      appPath,
      settings: SETTINGS,
      taskId: "t_test_005",
      sessionId: "55555555-5555-5555-5555-555555555555",
    });
    expect(handle).not.toBeNull();
    // Force the cutoff to "now + 1s in the future" so the existing
    // worktree (mtime is "now") is treated as stale.
    const removed = await pruneStaleWorktrees({
      appPath,
      staleAfterMs: -1000,
    });
    expect(removed).toBeGreaterThanOrEqual(1);
    expect(existsSync(handle!.path)).toBe(false);
  });

  it("pruneStaleWorktrees skips fresh worktrees when cutoff is high", async () => {
    const handle = await createWorktreeForRun({
      appPath,
      settings: SETTINGS,
      taskId: "t_test_006",
      sessionId: "66666666-6666-6666-6666-666666666666",
    });
    expect(handle).not.toBeNull();
    const removed = await pruneStaleWorktrees({
      appPath,
      // Cutoff far in the past — nothing should match.
      staleAfterMs: 24 * 60 * 60 * 1000,
    });
    expect(removed).toBe(0);
    expect(existsSync(handle!.path)).toBe(true);
  });
});
