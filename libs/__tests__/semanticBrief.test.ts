import { describe, expect, it, vi } from "vitest";
import { mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { INSUFFICIENT_EVIDENCE, buildSemanticBrief, reportPathForRun } from "../semanticVerifier";
import type { Run } from "../meta";

const TMP_SESSIONS = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { mkdtempSync } = require("node:fs") as typeof import("node:fs");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { tmpdir } = require("node:os") as typeof import("node:os");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { join: j } = require("node:path") as typeof import("node:path");
  return mkdtempSync(j(tmpdir(), "bridge-semantic-brief-"));
});

vi.mock("../paths", async () => {
  const actual = await vi.importActual<typeof import("../paths")>("../paths");
  return { ...actual, SESSIONS_DIR: TMP_SESSIONS };
});

const TASK_ID = "t_20260905_020";

function run(over: Partial<Run> = {}): Run {
  return {
    sessionId: "11111111-1111-1111-1111-111111111111",
    role: "coder-t2",
    repo: "ant-design",
    status: "done",
    startedAt: "2026-09-05T09:00:00Z",
    endedAt: "2026-09-05T09:30:00Z",
    ...over,
  } as Run;
}

describe("buildSemanticBrief", () => {
  it("hands the judge an absolute report path and an explicit git -C target", () => {
    const brief = buildSemanticBrief({
      taskId: TASK_ID,
      finishedRun: run(),
      repoPath: "X:\\srv\\test-repos\\ant-design",
    });
    expect(brief).toContain(
      `${TMP_SESSIONS.replace(/\\/g, "/")}/${TASK_ID}/reports/coder-t2-ant-design.md`,
    );
    expect(brief).toContain('git -C "X:/srv/test-repos/ant-design" diff HEAD');
    // The cwd-relative forms are what broke for placeholder-repo runs.
    expect(brief).not.toContain("<bridge>/sessions/<task>");
    expect(brief).not.toMatch(/Cross-check `git diff HEAD`/);
  });

  it("tells the judge to abstain rather than fail a change it never saw", () => {
    const brief = buildSemanticBrief({
      taskId: TASK_ID,
      finishedRun: run(),
      repoPath: "/repo",
    });
    expect(brief).toContain(INSUFFICIENT_EVIDENCE);
    expect(brief).toContain("## Changed files");
    expect(brief.toLowerCase()).toContain("placeholder");
  });

  it("tells the judge what to do when the REPORT is missing, not just the diff", () => {
    const brief = buildSemanticBrief({
      taskId: TASK_ID,
      finishedRun: run(),
      repoPath: "/repo",
    });
    // Points at the reports dir it should list, and at the same-role /
    // different-repo shape it should look for.
    expect(brief).toContain(`ls "${TMP_SESSIONS.replace(/\\/g, "/")}/${TASK_ID}/reports"`);
    expect(brief).toContain("coder-t2-<some-other-repo>.md");
    // …and abstaining covers "no report", not only "no diff".
    expect(brief).toMatch(/no report at all for this run/);
  });
});

let taskSeq = 0;

/** Fresh, empty `reports/` dir per case so one test's files cannot leak. */
function reportsDirFor(files: Record<string, string> = {}): { taskId: string; dir: string } {
  const taskId = `t_20260905_1${String(taskSeq++).padStart(2, "0")}`;
  const dir = join(TMP_SESSIONS, taskId, "reports");
  rmSync(join(TMP_SESSIONS, taskId), { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  for (const [name, body] of Object.entries(files)) {
    writeFileSync(join(dir, name), body);
  }
  return { taskId, dir };
}

function setMtime(path: string, epochSeconds: number): void {
  utimesSync(path, epochSeconds, epochSeconds);
}

describe("reportPathForRun", () => {
  it("returns the run's own report when it exists", () => {
    const { taskId, dir } = reportsDirFor({ "coder-ant-design.md": "# coder" });
    expect(reportPathForRun(taskId, run({ role: "coder" }))).toBe(
      join(dir, "coder-ant-design.md"),
    );
  });

  it("does not let the repo-direction fallback hijack a run whose own report exists", () => {
    // Both halves present: the exact `<role>-<repo>.md` must still win, even
    // though a same-role/other-repo file is sitting right next to it.
    const { taskId, dir } = reportsDirFor({
      "coder-ant-design.md": "# the run's own report",
      "coder-claude-bridge.md": "# a sibling's report",
    });
    expect(reportPathForRun(taskId, run({ role: "coder" }))).toBe(
      join(dir, "coder-ant-design.md"),
    );
  });

  it("finds the report when the run's repo is a placeholder (F1: repo-direction fallback)", () => {
    // The exact case this run hit: row says repo `ant-design`, the work and the
    // report landed in `claude-bridge`. Before the fallback existed this
    // returned a path that does not exist, and the brief told the judge to
    // trust it.
    const { taskId, dir } = reportsDirFor({
      "coder-t2-claude-bridge.md": "# coder-t2",
    });
    expect(reportPathForRun(taskId, run({ role: "coder-t2", repo: "ant-design" }))).toBe(
      join(dir, "coder-t2-claude-bridge.md"),
    );
  });

  it("prefers the exact repo, then the newest, when several same-role reports exist", () => {
    const { taskId, dir } = reportsDirFor({
      "coder-t2-claude-bridge.md": "# older",
      "coder-t2-edusoft-lms.md": "# newer",
    });
    setMtime(join(dir, "coder-t2-claude-bridge.md"), 1_600_000_000);
    setMtime(join(dir, "coder-t2-edusoft-lms.md"), 1_700_000_000);

    // No exact `-ant-design.md` → newest mtime wins.
    expect(reportPathForRun(taskId, run({ role: "coder-t2", repo: "ant-design" }))).toBe(
      join(dir, "coder-t2-edusoft-lms.md"),
    );
    // Exact repo match outranks mtime, even though it is the older file.
    expect(reportPathForRun(taskId, run({ role: "coder-t2", repo: "claude-bridge" }))).toBe(
      join(dir, "coder-t2-claude-bridge.md"),
    );
  });

  it("falls back to the base role's report for a retry run", () => {
    const { taskId, dir } = reportsDirFor({ "coder-ant-design.md": "# coder" });
    expect(reportPathForRun(taskId, run({ role: "coder-svretry2" }))).toBe(
      join(dir, "coder-ant-design.md"),
    );
  });

  it("still returns the primary path when nothing has been written yet", () => {
    const { taskId, dir } = reportsDirFor();
    expect(reportPathForRun(taskId, run({ role: "coder" }))).toBe(
      join(dir, "coder-ant-design.md"),
    );
  });

  it("returns the primary path (never throws) when the reports dir does not exist", () => {
    expect(reportPathForRun("t_20260905_199", run({ role: "coder" }))).toBe(
      join(TMP_SESSIONS, "t_20260905_199", "reports", "coder-ant-design.md"),
    );
  });
});

/** The brief renders every path with forward slashes, tests must match. */
function posix(p: string): string {
  return p.replace(/\\/g, "/");
}

describe("buildSemanticBrief — how sure the bridge is about the report", () => {
  const brief = (taskId: string, over: Partial<Run> = {}) =>
    buildSemanticBrief({ taskId, finishedRun: run(over), repoPath: "/repo" });

  it("asserts the path only when the report is really there", () => {
    const { taskId, dir } = reportsDirFor({ "coder-ant-design.md": "# coder" });
    const text = brief(taskId, { role: "coder" });
    expect(text).toContain(`${posix(join(dir, "coder-ant-design.md"))}\``);
    expect(text).toContain("that absolute path, not a cwd-relative guess");
    expect(text).not.toContain("could not find any report");
  });

  it("warns the judge when NO report exists instead of asserting a dead path (F2)", () => {
    const { taskId } = reportsDirFor();
    const text = brief(taskId, { role: "coder" });
    // The old brief said "that absolute path, not a cwd-relative guess" about a
    // file nothing had written — the judge chased it and then voted on its absence.
    expect(text).not.toContain("that absolute path, not a cwd-relative guess");
    expect(text).toContain("could not find any report for this run on disk");
    // Still points at the dir to search and at the abstain verdict.
    expect(text).toContain("ls \"");
    expect(text).toContain(INSUFFICIENT_EVIDENCE);
  });

  it("discloses the ambiguity when several same-role reports could be the one (F1)", () => {
    const { taskId, dir } = reportsDirFor({
      "coder-t2-claude-bridge.md": "# older",
      "coder-t2-edusoft-lms.md": "# newer",
    });
    setMtime(join(dir, "coder-t2-claude-bridge.md"), 1_600_000_000);
    setMtime(join(dir, "coder-t2-edusoft-lms.md"), 1_700_000_000);

    const text = brief(taskId, { role: "coder-t2", repo: "ant-design" });
    // Picked the newest…
    expect(text).toContain(posix(join(dir, "coder-t2-edusoft-lms.md")));
    // …but said so, and named the one it passed over, so the tie-break is not silent.
    expect(text).toContain("coder-t2-claude-bridge.md");
    expect(text).toContain("most recently modified");
  });

  it("stays quiet about ambiguity when exactly one report matches", () => {
    const { taskId } = reportsDirFor({ "coder-t2-claude-bridge.md": "# the only one" });
    const text = brief(taskId, { role: "coder-t2", repo: "ant-design" });
    expect(text).not.toContain("most recently modified");
    expect(text).toContain("that absolute path, not a cwd-relative guess");
  });
});
