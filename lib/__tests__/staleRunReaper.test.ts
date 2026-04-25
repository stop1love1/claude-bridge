import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMeta, appendRun, readMeta } from "../meta";
import { reapStaleRunsForDir } from "../staleRunReaper";

let tmp: string;
beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), "reaper-")); });
afterEach(() => {
  delete process.env.BRIDGE_STALE_RUN_MIN;
  delete process.env.BRIDGE_QUEUED_STALE_MIN;
});

const HEADER_FRESH = {
  taskId: "t_reaper_fresh",
  taskTitle: "fresh task",
  taskBody: "",
  taskStatus: "todo" as const,
  taskSection: "TODO" as const,
  taskChecked: false,
  // Set in each test based on age requirement.
  createdAt: new Date().toISOString(),
};

function withCreatedAt(iso: string) {
  return { ...HEADER_FRESH, createdAt: iso };
}

describe("reapStaleRunsForDir — H4 queued state", () => {
  it("flips a queued run to failed when meta.createdAt is older than the cutoff", () => {
    // 5 minutes ago, well past the default 2-minute queued cutoff.
    const oldCreated = new Date(Date.now() - 5 * 60_000).toISOString();
    const dir = join(tmp, "t_q1");
    createMeta(dir, withCreatedAt(oldCreated));
    appendRun(dir, {
      sessionId: "stuck-queued",
      role: "coder",
      repo: "fake",
      status: "queued",
      startedAt: null,
      endedAt: null,
    });

    const meta = reapStaleRunsForDir(dir);
    expect(meta).not.toBeNull();
    const run = meta!.runs[0];
    expect(run.status).toBe("failed");
    expect(run.endedAt).not.toBeNull();

    // Confirm persisted.
    const reread = readMeta(dir);
    expect(reread!.runs[0].status).toBe("failed");
  });

  it("leaves a freshly-queued run alone (within the cutoff window)", () => {
    const dir = join(tmp, "t_q2");
    createMeta(dir, HEADER_FRESH); // createdAt = now
    appendRun(dir, {
      sessionId: "fresh-queued",
      role: "coder",
      repo: "fake",
      status: "queued",
      startedAt: null,
      endedAt: null,
    });

    const meta = reapStaleRunsForDir(dir);
    expect(meta!.runs[0].status).toBe("queued");
  });

  it("respects BRIDGE_QUEUED_STALE_MIN env override", () => {
    process.env.BRIDGE_QUEUED_STALE_MIN = "0.01"; // ~600ms cutoff
    const dir = join(tmp, "t_q3");
    // createdAt = 30s ago — well past 0.01 min (=600ms)
    const old = new Date(Date.now() - 30_000).toISOString();
    createMeta(dir, withCreatedAt(old));
    appendRun(dir, {
      sessionId: "queued-via-env",
      role: "coder",
      repo: "fake",
      status: "queued",
      startedAt: null,
      endedAt: null,
    });

    const meta = reapStaleRunsForDir(dir);
    expect(meta!.runs[0].status).toBe("failed");
  });

  it("still reaps stale running rows alongside queued rows", () => {
    const dir = join(tmp, "t_q4");
    const old = new Date(Date.now() - 10 * 60_000).toISOString();
    createMeta(dir, withCreatedAt(old));
    appendRun(dir, {
      sessionId: "old-queued",
      role: "coder",
      repo: "fake",
      status: "queued",
      startedAt: null,
      endedAt: null,
    });
    appendRun(dir, {
      sessionId: "old-running",
      role: "coder",
      repo: "fake",
      status: "running",
      // 60 minutes ago, past the 30-minute running cutoff.
      startedAt: new Date(Date.now() - 60 * 60_000).toISOString(),
      endedAt: null,
    });

    const meta = reapStaleRunsForDir(dir);
    expect(meta!.runs[0].status).toBe("failed");
    expect(meta!.runs[1].status).toBe("failed");
  });

  it("does not touch done / failed rows", () => {
    const dir = join(tmp, "t_q5");
    const old = new Date(Date.now() - 60 * 60_000).toISOString();
    createMeta(dir, withCreatedAt(old));
    appendRun(dir, {
      sessionId: "done-already",
      role: "coder",
      repo: "fake",
      status: "done",
      startedAt: old,
      endedAt: old,
    });
    appendRun(dir, {
      sessionId: "failed-already",
      role: "coder",
      repo: "fake",
      status: "failed",
      startedAt: old,
      endedAt: old,
    });

    const meta = reapStaleRunsForDir(dir);
    expect(meta!.runs[0].status).toBe("done");
    expect(meta!.runs[1].status).toBe("failed");
    // endedAt unchanged
    expect(meta!.runs[1].endedAt).toBe(old);
  });
});
