import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mergeIntoTargetBranch, readCurrentBranch } from "../gitOps";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).toString();
}

function gitInit(dir: string): void {
  git(dir, "init", "-b", "main");
  git(dir, "config", "user.email", "merge@test.local");
  git(dir, "config", "user.name", "merge-test");
  writeFileSync(join(dir, "README.md"), "# tmp\n");
  git(dir, "add", ".");
  git(dir, "commit", "-m", "init");
}

let gitAvailable = false;
try {
  execFileSync("git", ["--version"], { stdio: "ignore" });
  gitAvailable = true;
} catch { /* skip */ }

const integration = gitAvailable ? describe : describe.skip;

integration("mergeIntoTargetBranch (real git)", () => {
  let repo: string;

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "bridge-merge-"));
    gitInit(repo);
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
