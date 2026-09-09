import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Run } from "../meta";

const TMP_SESSIONS = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { mkdtempSync } = require("node:fs") as typeof import("node:fs");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { tmpdir } = require("node:os") as typeof import("node:os");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { join } = require("node:path") as typeof import("node:path");
  return mkdtempSync(join(tmpdir(), "bridge-claimgate-sessions-"));
});
const TMP_STATE = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { mkdtempSync } = require("node:fs") as typeof import("node:fs");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { tmpdir } = require("node:os") as typeof import("node:os");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { join } = require("node:path") as typeof import("node:path");
  return mkdtempSync(join(tmpdir(), "bridge-claimgate-state-"));
});

vi.mock("../paths", async () => {
  const actual = await vi.importActual<typeof import("../paths")>("../paths");
  return { ...actual, SESSIONS_DIR: TMP_SESSIONS, BRIDGE_STATE_DIR: TMP_STATE };
});

const TASK_ID = "t_20260909_002";
let repo: string;

function git(...args: string[]): void {
  execFileSync("git", args, { cwd: repo, stdio: "ignore", windowsHide: true });
}

function write(rel: string, body: string): void {
  const abs = join(repo, rel);
  mkdirSync(abs.replace(/[\\/][^\\/]+$/, ""), { recursive: true });
  writeFileSync(abs, body, "utf8");
}

function writeReport(role: string, changedFilesSection: string[]): void {
  const dir = join(TMP_SESSIONS, TASK_ID, "reports");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${role}-app-web.md`),
    [
      `# ${role} @ app-web`,
      "",
      "## Verdict",
      "DONE",
      "",
      "## Changed files",
      ...changedFilesSection,
      "",
      "## How to verify",
      "Run the tests.",
      "",
    ].join("\n"),
    "utf8",
  );
}

function run(role: string, over: Partial<Run> = {}): Run {
  return {
    sessionId: "cccccccc-1111-2222-3333-444444444444",
    role,
    repo: "app-web",
    status: "done",
    startedAt: "2026-09-09T10:00:00Z",
    endedAt: "2026-09-09T10:01:00Z",
    ...over,
  };
}

beforeEach(() => {
  repo = mkdtempSync(join(TMP_STATE, "app-web-"));
  git("init", "-q");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
  git("config", "commit.gpgsign", "false");
  write("math.ts", "export const add = (a: number, b: number) => a + b;\n");
  write("README.md", "# fixture\n");
  git("add", "-A");
  git("commit", "-qm", "seed");
});

afterEach(() => {
  try { rmSync(join(TMP_SESSIONS, TASK_ID), { recursive: true, force: true }); } catch { }
  try { rmSync(repo, { recursive: true, force: true }); } catch { }
});

/**
 * The regression this covers happened for real: a `ui-tester` wrote the
 * `(none — analysis only)` its playbook prescribes, the gate compared it to the
 * whole working tree — still holding the eleven files the `coder` before it had
 * changed, because the bridge only auto-commits at the end — and sent it back
 * for a retry it could not pass without listing somebody else's files.
 */
describe("runVerifier with a dispatch-time baseline", () => {
  it("passes a read-only run dispatched into a tree a coder already dirtied", async () => {
    const { captureDiffBaseline } = await import("../diffBaseline");
    const { runVerifier } = await import("../verifier");

    write("math.ts", "// the coder's work\n");
    write("README.md", "# the coder's work\n");
    const diffBaseline = await captureDiffBaseline(repo);
    expect(Object.keys(diffBaseline!.files).sort()).toEqual(["README.md", "math.ts"]);

    writeReport("ui-tester", ["- (none — analysis only)"]);
    const v = await runVerifier({
      appPath: repo,
      taskId: TASK_ID,
      finishedRun: run("ui-tester", { diffBaseline }),
    });

    expect(v.verdict).toBe("pass");
    expect(v.claimedFiles).toEqual([]);
    // The full tree is still recorded — the baseline changes attribution, not
    // what the run observed.
    expect(v.actualFiles.sort()).toEqual(["README.md", "math.ts"]);
    expect(v.unclaimedActual).toEqual([]);
  });

  it("still fails a read-only run that edited code and declared nothing", async () => {
    const { captureDiffBaseline } = await import("../diffBaseline");
    const { runVerifier } = await import("../verifier");

    write("math.ts", "// the coder's work\n");
    const diffBaseline = await captureDiffBaseline(repo);
    write("README.md", "# quietly rewritten by the reviewer\n");

    writeReport("reviewer", ["- (none — analysis only)"]);
    const v = await runVerifier({
      appPath: repo,
      taskId: TASK_ID,
      finishedRun: run("reviewer", { diffBaseline }),
    });

    expect(v.verdict).toBe("broken");
    expect(v.reason).toContain("silent edits");
    expect(v.unclaimedActual).toEqual(["README.md"]);
  });

  it("still makes a coder declare the files it actually changed", async () => {
    const { captureDiffBaseline } = await import("../diffBaseline");
    const { runVerifier } = await import("../verifier");

    const diffBaseline = await captureDiffBaseline(repo);
    write("math.ts", "// the coder's work\n");

    writeReport("coder", ["- (none — analysis only)"]);
    expect(
      (await runVerifier({
        appPath: repo,
        taskId: TASK_ID,
        finishedRun: run("coder", { diffBaseline }),
      })).verdict,
    ).toBe("broken");

    writeReport("coder", ["- `math.ts` — added the thing"]);
    expect(
      (await runVerifier({
        appPath: repo,
        taskId: TASK_ID,
        finishedRun: run("coder", { diffBaseline }),
      })).verdict,
    ).toBe("pass");
  });

  it("a claim retry reusing the baseline must still declare the first attempt's edits", async () => {
    // The retry keeps the original run row, so it keeps the original baseline.
    // Re-snapshotting here would make attempt 1's edits invisible and let the
    // retry pass with "(none)" — the gate would stop working exactly where it
    // matters most.
    const { captureDiffBaseline } = await import("../diffBaseline");
    const { runVerifier } = await import("../verifier");

    const diffBaseline = await captureDiffBaseline(repo);
    write("math.ts", "// attempt 1's work, mis-declared\n");

    writeReport("coder-cretry", ["- (none — analysis only)"]);
    const v = await runVerifier({
      appPath: repo,
      taskId: TASK_ID,
      finishedRun: run("coder-cretry", { diffBaseline, retryAttempt: 1 }),
    });
    expect(v.verdict).toBe("broken");
    expect(v.unclaimedActual).toEqual(["math.ts"]);
  });

  it("degrades to the whole-tree comparison when no baseline was captured", async () => {
    const { runVerifier } = await import("../verifier");

    write("math.ts", "// somebody's work\n");
    writeReport("reviewer", ["- (none — analysis only)"]);
    const v = await runVerifier({
      appPath: repo,
      taskId: TASK_ID,
      finishedRun: run("reviewer"),
    });

    // Same false positive as before the fix — deliberately unchanged, so a
    // failed capture never turns the gate into a rubber stamp.
    expect(v.verdict).toBe("broken");
    expect(v.reason).toContain("silent edits");
  });
});
