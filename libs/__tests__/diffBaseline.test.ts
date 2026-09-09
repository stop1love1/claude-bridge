import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  attributableChanges,
  captureDiffBaseline,
  readDirtyFiles,
} from "../diffBaseline";
import { deriveVerdict } from "../verifier";

/**
 * The scenario the baseline exists for: the bridge runs several children per
 * task against one shared working tree and only auto-commits at the end, so a
 * `reviewer` or `ui-tester` dispatched after a `coder` starts its life looking
 * at eleven files it never touched.
 */

let repo: string;

function git(...args: string[]): void {
  execFileSync("git", args, { cwd: repo, stdio: "ignore", windowsHide: true });
}

function write(rel: string, body: string): void {
  const abs = join(repo, rel);
  mkdirSync(abs.replace(/[\\/][^\\/]+$/, ""), { recursive: true });
  writeFileSync(abs, body, "utf8");
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "bridge-diffbaseline-"));
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
  try { rmSync(repo, { recursive: true, force: true }); } catch { }
});

describe("captureDiffBaseline", () => {
  it("is empty on a clean tree, so a first-run coder sees the old behaviour", async () => {
    const baseline = await captureDiffBaseline(repo);
    expect(baseline).not.toBeNull();
    expect(Object.keys(baseline!.files)).toEqual([]);
  });

  it("records every dirty path with a content digest", async () => {
    write("math.ts", "export const add = (a: number, b: number) => a + b + 0;\n");
    write("new.ts", "export const x = 1;\n");
    const baseline = await captureDiffBaseline(repo);
    expect(Object.keys(baseline!.files).sort()).toEqual(["math.ts", "new.ts"]);
    expect(baseline!.files["math.ts"]).toMatch(/^[0-9a-f]{40}$/);
  });

  it("returns null rather than throwing when the directory is not a git repo", async () => {
    const notARepo = mkdtempSync(join(tmpdir(), "bridge-notgit-"));
    try {
      expect(await captureDiffBaseline(notARepo)).toBeNull();
    } finally {
      rmSync(notARepo, { recursive: true, force: true });
    }
  });
});

describe("attributableChanges", () => {
  it("subtracts files a predecessor left dirty", async () => {
    write("math.ts", "// coder was here\n");
    const baseline = await captureDiffBaseline(repo);
    const actual = await readDirtyFiles(repo);
    expect(actual).toEqual(["math.ts"]);
    expect(attributableChanges({ actual, baseline, appPath: repo })).toEqual([]);
  });

  it("keeps a file the run edited on top of a predecessor's edit", async () => {
    write("math.ts", "// coder was here\n");
    const baseline = await captureDiffBaseline(repo);
    write("math.ts", "// coder was here\n// and so was the reviewer\n");
    const actual = await readDirtyFiles(repo);
    expect(attributableChanges({ actual, baseline, appPath: repo })).toEqual(["math.ts"]);
  });

  it("keeps a file that was clean at dispatch", async () => {
    const baseline = await captureDiffBaseline(repo);
    write("math.ts", "// snuck in\n");
    const actual = await readDirtyFiles(repo);
    expect(attributableChanges({ actual, baseline, appPath: repo })).toEqual(["math.ts"]);
  });

  it("falls back to the whole tree when there is no baseline", async () => {
    write("math.ts", "// coder was here\n");
    const actual = await readDirtyFiles(repo);
    for (const baseline of [null, undefined]) {
      expect(attributableChanges({ actual, baseline, appPath: repo })).toEqual(["math.ts"]);
    }
  });

  it("treats a deleted-then-restored predecessor file by content, not by path", async () => {
    rmSync(join(repo, "math.ts"));
    const baseline = await captureDiffBaseline(repo);
    expect(baseline!.files["math.ts"]).toBeNull();
    // The run puts something back at that path — different content, so it is
    // this run's doing even though the path was already in the baseline.
    write("math.ts", "export const add = 0;\n");
    const actual = await readDirtyFiles(repo);
    expect(attributableChanges({ actual, baseline, appPath: repo })).toEqual(["math.ts"]);
  });
});

describe("the claim gate with a baseline — both directions", () => {
  it("passes a read-only run that changed nothing after a coder dirtied the tree", async () => {
    write("math.ts", "// coder\n");
    write("libs/foo.ts", "// coder\n");
    const baseline = await captureDiffBaseline(repo);
    const actual = await readDirtyFiles(repo);
    const attributed = attributableChanges({ actual, baseline, appPath: repo });

    // What a ui-tester's playbook tells it to write.
    const v = deriveVerdict({ claimed: [], actual, attributed });
    expect(v.verdict).toBe("pass");
    expect(v.reason).toContain("predate this run");
    expect(v.unclaimedActual).toEqual([]);
  });

  it("still catches a read-only run that edited a tracked file and said nothing", async () => {
    write("math.ts", "// coder\n");
    const baseline = await captureDiffBaseline(repo);
    write("README.md", "# the reviewer edited this and did not say so\n");
    const actual = await readDirtyFiles(repo);
    const attributed = attributableChanges({ actual, baseline, appPath: repo });

    const v = deriveVerdict({ claimed: [], actual, attributed });
    expect(v.verdict).toBe("broken");
    expect(v.reason).toContain("silent edits");
    expect(v.unclaimedActual).toEqual(["README.md"]);
    // And the retry prompt names only the file this run is answerable for.
    expect(v.unclaimedActual).not.toContain("math.ts");
  });

  it("catches a new file dropped into a directory a predecessor created", async () => {
    // `git status --porcelain` collapses a wholly-untracked directory into one
    // `libs/` line, so both runs show up under the same path. Only the
    // directory digest tells them apart.
    write("libs/foo.ts", "// coder\n");
    const baseline = await captureDiffBaseline(repo);
    expect(Object.keys(baseline!.files)).toEqual(["libs/"]);

    write("libs/sneaky.ts", "// the reviewer, quietly\n");
    const actual = await readDirtyFiles(repo);
    const attributed = attributableChanges({ actual, baseline, appPath: repo });

    expect(attributed).toEqual(["libs/"]);
    expect(deriveVerdict({ claimed: [], actual, attributed }).verdict).toBe("broken");
  });

  it("leaves an untouched predecessor directory alone", async () => {
    write("libs/foo.ts", "// coder\n");
    const baseline = await captureDiffBaseline(repo);
    const actual = await readDirtyFiles(repo);
    expect(attributableChanges({ actual, baseline, appPath: repo })).toEqual([]);
  });

  it("still makes a coder declare its own files", async () => {
    const baseline = await captureDiffBaseline(repo);
    write("math.ts", "// the coder's actual work\n");
    const actual = await readDirtyFiles(repo);
    const attributed = attributableChanges({ actual, baseline, appPath: repo });

    expect(deriveVerdict({ claimed: [], actual, attributed }).verdict).toBe("broken");
    expect(deriveVerdict({ claimed: ["math.ts"], actual, attributed }).verdict).toBe("pass");
  });

  it("tolerates a run that over-claims a predecessor's file", async () => {
    // Naming someone else's file is over-reporting, not a lie — and failing it
    // is what pushed agents into padding reports with other people's changes.
    write("math.ts", "// coder\n");
    const baseline = await captureDiffBaseline(repo);
    const actual = await readDirtyFiles(repo);
    const attributed = attributableChanges({ actual, baseline, appPath: repo });

    expect(deriveVerdict({ claimed: ["math.ts"], actual, attributed }).verdict).toBe("pass");
  });

  it("still calls out a claim that is nowhere in the tree", async () => {
    write("math.ts", "// coder\n");
    const baseline = await captureDiffBaseline(repo);
    const actual = await readDirtyFiles(repo);
    const attributed = attributableChanges({ actual, baseline, appPath: repo });

    const v = deriveVerdict({ claimed: ["ghost.ts"], actual, attributed });
    expect(v.verdict).toBe("drift");
    expect(v.unmatchedClaims).toEqual(["ghost.ts"]);
  });

  it("behaves exactly as before when no baseline was captured", async () => {
    write("math.ts", "// coder\n");
    const actual = await readDirtyFiles(repo);
    const v = deriveVerdict({ claimed: [], actual });
    expect(v.verdict).toBe("broken");
    expect(v.reason).toContain("silent edits");
  });
});
