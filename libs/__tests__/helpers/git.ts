import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

export interface GitInitOpts {
  branch?: string;
  email?: string;
  name?: string;
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

export function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).toString();
}
