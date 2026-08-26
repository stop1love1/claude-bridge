import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createWorktreeForRun,
  inheritWorktreeFields,
  mergeAndRemoveWorktree,
  pruneStaleWorktrees,
  removeWorktree,
  worktreePathFor,
} from "../worktrees";
import type { AppGitSettings } from "../apps";
import { git, gitInit } from "./helpers/git";
import { mktmp } from "./helpers/fs";

// Point SESSIONS_DIR at a per-run temp dir so the pruner's
// active/held-session scan (collectActiveSessionIds) reads test-owned
// meta.json files instead of the real bridge sessions folder. All other
// paths exports stay real.
vi.mock("../paths", async () => {
  const actual = await vi.importActual<typeof import("../paths")>("../paths");
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir: osTmpdir } = await import("node:os");
  const { join: pathJoin } = await import("node:path");
  return { ...actual, SESSIONS_DIR: mkdtempSync(pathJoin(osTmpdir(), "wt-sessions-")) };
});

const SETTINGS: AppGitSettings = {
  branchMode: "auto-create",
  fixedBranch: "",
  autoCommit: false,
  autoPush: false,
  worktreeMode: "enabled",
  mergeTargetBranch: "",
  integrationMode: "none",
};

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
    appPath = mktmp("wt");
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

  it("pruneStaleWorktrees keeps worktrees with recent DEEP edits even when root mtime is old", async () => {
    const handle = await createWorktreeForRun({
      appPath,
      settings: SETTINGS,
      taskId: "t_test_007",
      sessionId: "77777777-7777-7777-7777-777777777777",
    });
    expect(handle).not.toBeNull();

    // Backdate root + everything we wrote initially so a
    // root-mtime-only check would treat the worktree as stale.
    const oneHourAgoSec = Date.now() / 1000 - 3600;
    utimesSync(handle!.path, oneHourAgoSec, oneHourAgoSec);

    // Now edit a deeply-nested file. Walking only the root mtime
    // would still see "an hour ago" — only a depth-aware scan picks
    // this up.
    const deepDir = join(handle!.path, "src", "components", "deep");
    mkdirSync(deepDir, { recursive: true });
    writeFileSync(join(deepDir, "edit.ts"), "// fresh edit\n");

    const removed = await pruneStaleWorktrees({
      appPath,
      staleAfterMs: 60 * 1000, // 60s — root would be reaped without deep scan
    });
    expect(removed).toBe(0);
    expect(existsSync(handle!.path)).toBe(true);
  });

  it("pruneStaleWorktrees keeps a HELD worktree (confidence.heldAt, unreviewed) past TTL, reaps it once reviewed", async () => {
    // Task 7: a low-confidence worktree run held via `holdWorktree`
    // parks its worktree for operator review. The run's status is
    // already `done` (the gates flipped it before confidence scoring),
    // so the queued/running exemption alone would let the TTL pruner
    // reap the parked worktree out from under the pending review —
    // after which `ship` 404s forever while `heldAt` is stuck.
    const sid = "88888888-8888-8888-8888-888888888888";
    const handle = await createWorktreeForRun({
      appPath,
      settings: SETTINGS,
      taskId: "t_test_held",
      sessionId: sid,
    });
    expect(handle).not.toBeNull();

    const { SESSIONS_DIR } = await import("../paths");
    const { createMeta, appendRun, updateRun } = await import("../meta");
    const taskDir = join(SESSIONS_DIR, "t_test_held");
    createMeta(taskDir, {
      taskId: "t_test_held",
      taskTitle: "held task",
      taskBody: "held body",
      taskStatus: "doing",
      taskSection: "DOING",
      taskChecked: false,
      createdAt: "2026-07-10T10:00:00Z",
    });
    await appendRun(taskDir, {
      sessionId: sid,
      role: "coder",
      repo: "real-app",
      status: "done", // gates already flipped it — NOT queued/running
      startedAt: "2026-07-10T10:00:01Z",
      endedAt: "2026-07-10T10:00:02Z",
      worktreePath: handle!.path,
      worktreeBranch: handle!.branch,
      worktreeBaseBranch: handle!.baseBranch,
      confidence: { score: 50, band: "low", heldAt: "2026-07-10T10:00:03Z", reviewedBy: null },
    });

    try {
      // Cutoff in the future (staleAfterMs < 0) → everything is "past
      // TTL". The held run's worktree must survive anyway.
      await pruneStaleWorktrees({ appPath, staleAfterMs: -1000 });
      expect(existsSync(handle!.path)).toBe(true);

      // Operator resolves the hold (dismiss clears heldAt + stamps
      // reviewedBy) → the exemption lapses and the pruner may reap.
      await updateRun(taskDir, sid, {
        confidence: {
          score: 50,
          band: "low",
          heldAt: null,
          reviewedBy: { label: "operator", at: "2026-07-11T10:00:00Z" },
        },
      });
      const removed = await pruneStaleWorktrees({ appPath, staleAfterMs: -1000 });
      expect(removed).toBeGreaterThanOrEqual(1);
      expect(existsSync(handle!.path)).toBe(false);
    } finally {
      try { rmSync(taskDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });

  it("aborts the merge and leaves the live tree clean when merge-back conflicts", async () => {
    // Set up: base branch with a file; worktree branch edits line 1;
    // live tree commits a conflicting edit to line 1 on the base branch.
    const handle = await createWorktreeForRun({
      appPath,
      settings: SETTINGS,
      taskId: "t_test_conflict",
      sessionId: "99999999-9999-9999-9999-999999999999",
    });
    expect(handle).not.toBeNull();
    expect(handle!.baseBranch).not.toBeNull();

    // Worktree side: edit README.md and commit onto the spawn branch.
    writeFileSync(join(handle!.path, "README.md"), "# worktree edit\n");
    execFileSync("git", ["add", "."], { cwd: handle!.path, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "worktree edit"], { cwd: handle!.path, stdio: "ignore" });

    // Live tree side: check out the base branch and commit a conflicting
    // edit to the same line, so the merge-back is guaranteed to conflict.
    execFileSync("git", ["checkout", handle!.baseBranch!], { cwd: appPath, stdio: "ignore" });
    writeFileSync(join(appPath, "README.md"), "# live edit\n");
    execFileSync("git", ["add", "."], { cwd: appPath, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "live edit"], { cwd: appPath, stdio: "ignore" });

    const res = await mergeAndRemoveWorktree({ appPath, handle: handle! });

    expect(res.ok).toBe(false);
    // The live tree must NOT be left mid-merge.
    const status = git(appPath, "status", "--porcelain");
    expect(status.trim()).toBe("");
    const mergeHead = existsSync(join(appPath, ".git", "MERGE_HEAD"));
    expect(mergeHead).toBe(false);
    // The worktree is the only copy of the unmerged work — it must
    // still be there for the operator to find.
    expect(existsSync(handle!.path)).toBe(true);
  });
});
