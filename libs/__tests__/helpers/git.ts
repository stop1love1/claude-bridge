import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Initialize a fresh git repo at `dir` with one bootstrap commit so
 * tests that need branches / HEAD have something concrete to point at.
 *
 * Defaults match the pre-extraction inline copies: `main` as the
 * primary branch, anonymous `bridge-test@local` author. Override via
 * `opts` when a test needs a specific identity (e.g. multi-author
 * merge cases).
 */
export interface GitInitOpts {
  /** Initial branch name. Default `main`. */
  branch?: string;
  /** Author email for `user.email`. Default `bridge-test@local`. */
  email?: string;
  /** Author name for `user.name`. Default `bridge-test`. */
  name?: string;
  /** Bootstrap-commit message. Default `init`. */
  initialCommitMessage?: string;
}

export function gitInit(dir: string, opts: GitInitOpts = {}): void {
  const branch = opts.branch ?? "main";
  const email = opts.email ?? "bridge-test@local";
  const name = opts.name ?? "bridge-test";
  const message = opts.initialCommitMessage ?? "init";

  execFileSync("git", ["init", "-b", branch], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", email], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", name], { cwd: dir, stdio: "ignore" });
  writeFileSync(join(dir, "README.md"), "# tmp\n");
  execFileSync("git", ["add", "."], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", message], { cwd: dir, stdio: "ignore" });
}

/**
 * Run a git command in `cwd`, capturing stdout. Tests use this for
 * read-only verification (`git log`, `git rev-parse HEAD`, …) and for
 * one-off setup commands that the test would otherwise inline.
 */
export function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).toString();
}
