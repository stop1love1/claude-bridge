import { beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { appendRun, createMeta, type Run } from "../meta";
import type { RunStatus } from "../runStatus";
import { claimRunForResume } from "../resumeGuard";

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "resume-guard-"));
});

async function makeTaskDir(opts: {
  runs: Array<Partial<Run> & { sessionId: string; status: RunStatus; role: string }>;
}): Promise<string> {
  const dir = join(tmp, `t_${Math.random().toString(36).slice(2, 10)}`);
  createMeta(dir, {
    taskId: basename(dir),
    taskTitle: "resume guard test",
    taskBody: "test task",
    taskStatus: "todo",
    taskSection: "TODO",
    taskChecked: false,
    createdAt: "2026-08-27T00:00:00.000Z",
  });
  for (const r of opts.runs) {
    await appendRun(dir, {
      repo: "claude-bridge",
      startedAt: "2026-08-27T00:00:00.000Z",
      endedAt: "2026-08-27T00:05:00.000Z",
      ...r,
    });
  }
  return dir;
}

describe("claimRunForResume", () => {
  it("only the first of two concurrent resumes wins", async () => {
    const dir = await makeTaskDir({ runs: [{ sessionId: "s1", status: "done", role: "coder" }] });
    const results = await Promise.all([
      claimRunForResume(dir, "s1"),
      claimRunForResume(dir, "s1"),
    ]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
  });

  it("refuses to resume a run that is already running", async () => {
    const dir = await makeTaskDir({ runs: [{ sessionId: "s1", status: "running", role: "coder" }] });
    expect((await claimRunForResume(dir, "s1")).ok).toBe(false);
  });

  it("refuses to resume a queued run", async () => {
    const dir = await makeTaskDir({ runs: [{ sessionId: "s1", status: "queued", role: "coder" }] });
    expect((await claimRunForResume(dir, "s1")).ok).toBe(false);
  });

  it("reports the live status on a failed claim, for the caller's 409", async () => {
    const dir = await makeTaskDir({ runs: [{ sessionId: "s1", status: "running", role: "coder" }] });
    const result = await claimRunForResume(dir, "s1");
    expect(result.ok).toBe(false);
    expect(result.run?.status).toBe("running");
  });

  it("flips status to running and clears endedAt on a successful claim", async () => {
    const dir = await makeTaskDir({ runs: [{ sessionId: "s1", status: "failed", role: "coder" }] });
    const result = await claimRunForResume(dir, "s1");
    expect(result.ok).toBe(true);
    expect(result.run?.status).toBe("running");
    expect(result.run?.endedAt).toBeNull();
  });

  it("applies an extra patch (e.g. role) atomically with the status flip", async () => {
    const dir = await makeTaskDir({ runs: [{ sessionId: "s1", status: "done", role: "coder" }] });
    const result = await claimRunForResume(dir, "s1", { role: "reviewer" });
    expect(result.ok).toBe(true);
    expect(result.run?.role).toBe("reviewer");
  });
});
