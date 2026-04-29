import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { mergeIntoTargetBranch, readCurrentBranch, withGitLock } from "../gitOps";
import { git, gitInit } from "./helpers/git";
import { mktmp } from "./helpers/fs";

let gitAvailable = false;
try {
  execFileSync("git", ["--version"], { stdio: "ignore" });
  gitAvailable = true;
} catch { /* skip */ }

const integration = gitAvailable ? describe : describe.skip;

integration("mergeIntoTargetBranch (real git)", () => {
  let repo: string;

  beforeEach(() => {
    repo = mktmp("merge");
    gitInit(repo, { email: "merge@test.local", name: "merge-test" });
  });
  afterEach(() => {
    rmSync(repo, { recursive: true, force: true, maxRetries: 3 });
  });

  it("merges a clean fast-forwardable branch into target and leaves HEAD on target", async () => {
    // Create a work branch with a new commit.
    git(repo, "checkout", "-b", "claude/t1");
    writeFileSync(join(repo, "feature.txt"), "hi\n");
    git(repo, "add", ".");
    git(repo, "commit", "-m", "feat");

    const r = await mergeIntoTargetBranch({
      cwd: repo,
      sourceBranch: "claude/t1",
      targetBranch: "main",
      message: "merge claude/t1",
      push: false,
    });
    expect(r.ok).toBe(true);
    expect(await readCurrentBranch(repo)).toBe("main");
    // The merge commit landed on main with the feature file present.
    const log = git(repo, "log", "--oneline", "main");
    expect(log).toMatch(/merge claude\/t1/);
  });

  it("aborts on conflict and returns HEAD to the source branch", async () => {
    // Diverge: main and claude/t1 both edit README.md.
    git(repo, "checkout", "-b", "claude/t1");
    writeFileSync(join(repo, "README.md"), "# branch edit\n");
    git(repo, "add", ".");
    git(repo, "commit", "-m", "branch edit");
    git(repo, "checkout", "main");
    writeFileSync(join(repo, "README.md"), "# main edit\n");
    git(repo, "add", ".");
    git(repo, "commit", "-m", "main edit");
    git(repo, "checkout", "claude/t1");

    const r = await mergeIntoTargetBranch({
      cwd: repo,
      sourceBranch: "claude/t1",
      targetBranch: "main",
      message: "should conflict",
      push: false,
    });
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/aborted/i);
    // We must end up back on the source so the operator can resolve manually.
    expect(await readCurrentBranch(repo)).toBe("claude/t1");
    // No half-applied merge state left behind.
    const status = git(repo, "status", "--porcelain");
    expect(status.trim()).toBe("");
  });

  it("creates the target branch from source when it doesn't exist locally", async () => {
    // Operator's `mergeTargetBranch=release/1.0` doesn't exist yet.
    git(repo, "checkout", "-b", "claude/t1");
    writeFileSync(join(repo, "feature.txt"), "hi\n");
    git(repo, "add", ".");
    git(repo, "commit", "-m", "feat");

    const r = await mergeIntoTargetBranch({
      cwd: repo,
      sourceBranch: "claude/t1",
      targetBranch: "release/1.0",
      message: "first cut",
      push: false,
    });
    expect(r.ok).toBe(true);
    expect(await readCurrentBranch(repo)).toBe("release/1.0");
  });

  it("no-ops when source equals target", async () => {
    const r = await mergeIntoTargetBranch({
      cwd: repo,
      sourceBranch: "main",
      targetBranch: "main",
      message: "noop",
      push: false,
    });
    expect(r.ok).toBe(true);
    expect(r.message).toMatch(/skipped/i);
  });

  it("refuses to merge when the working tree is dirty", async () => {
    git(repo, "checkout", "-b", "claude/t1");
    writeFileSync(join(repo, "dirty.txt"), "uncommitted\n");
    // Note: not committed.

    const r = await mergeIntoTargetBranch({
      cwd: repo,
      sourceBranch: "claude/t1",
      targetBranch: "main",
      message: "should refuse",
      push: false,
    });
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/uncommitted/i);
    // HEAD must not have moved.
    expect(await readCurrentBranch(repo)).toBe("claude/t1");
  });

  it("returns ok and a noop message when target is empty", async () => {
    const r = await mergeIntoTargetBranch({
      cwd: repo,
      sourceBranch: "main",
      targetBranch: "",
      message: "noop",
      push: false,
    });
    expect(r.ok).toBe(true);
    expect(r.message).toMatch(/no merge target/i);
  });
});

describe("withGitLock — cross-process file lock", () => {
  let cwd: string;

  beforeEach(() => {
    cwd = mktmp("gitlock");
    // mkdir .git/ so the lock lives there (matches the runtime path).
    mkdirSync(join(cwd, ".git"), { recursive: true });
  });
  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true, maxRetries: 3 });
  });

  it("creates the lock dir while running and removes it on completion", async () => {
    const lockDir = join(cwd, ".git", ".bridge-git-lock");
    let observedInside: boolean | null = null;
    await withGitLock(cwd, () => {
      observedInside = existsSync(lockDir);
    });
    expect(observedInside).toBe(true);
    expect(existsSync(lockDir)).toBe(false);
  });

  it("releases the lock even when the inner function throws", async () => {
    const lockDir = join(cwd, ".git", ".bridge-git-lock");
    await expect(
      withGitLock(cwd, () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(existsSync(lockDir)).toBe(false);
  });

  it("serializes two concurrent callers (second runs after first releases)", async () => {
    const lockDir = join(cwd, ".git", ".bridge-git-lock");
    const events: string[] = [];

    const a = withGitLock(cwd, async () => {
      events.push("a-start");
      await new Promise((r) => setTimeout(r, 80));
      // While we're inside, the second caller must NOT have started yet —
      // either because the in-process queue blocks it or the file lock does.
      events.push("a-end");
    });
    const b = withGitLock(cwd, () => {
      events.push("b-start");
      events.push("b-end");
    });

    await Promise.all([a, b]);
    expect(events).toEqual(["a-start", "a-end", "b-start", "b-end"]);
    expect(existsSync(lockDir)).toBe(false);
  });

  it("evicts a stale lock left behind by a crashed prior process", async () => {
    const lockDir = join(cwd, ".git", ".bridge-git-lock");
    // Simulate a stale lock from a process that died ~10 minutes ago.
    mkdirSync(lockDir);
    writeFileSync(
      join(lockDir, "owner"),
      JSON.stringify({ pid: 1, t: Date.now() - 10 * 60 * 1000 }),
    );

    const result = await withGitLock(cwd, () => "ok");
    expect(result).toBe("ok");
    expect(existsSync(lockDir)).toBe(false);
  });
});
