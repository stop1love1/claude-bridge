import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
  utimesSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { createMeta, appendRun, readMeta } from "../meta";
import { reapStaleRunsForDir } from "../staleRunReaper";
import { registerChild, unregisterChild } from "../spawnRegistry";
import { BRIDGE_FOLDER, BRIDGE_ROOT } from "../paths";
import { pathToSlug } from "../sessions";

let tmp: string;
beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), "reaper-")); });
afterEach(() => {
  delete process.env.BRIDGE_QUEUED_STALE_MIN;
});

function fakeChild(): ChildProcess {
  const ee = new EventEmitter() as unknown as ChildProcess & {
    exitCode: number | null;
    killed: boolean;
  };
  ee.exitCode = null;
  ee.killed = false;
  return ee;
}

const HEADER_FRESH = {
  taskId: "t_reaper_fresh",
  taskTitle: "fresh task",
  taskBody: "",
  taskStatus: "todo" as const,
  taskSection: "TODO" as const,
  taskChecked: false,
  createdAt: new Date().toISOString(),
};

function withCreatedAt(iso: string) {
  return { ...HEADER_FRESH, createdAt: iso };
}

describe("reapStaleRunsForDir — H4 queued state", () => {
  it("flips a queued run to failed when meta.createdAt is older than the cutoff", async () => {
    const oldCreated = new Date(Date.now() - 5 * 60_000).toISOString();
    const dir = join(tmp, "t_q1");
    createMeta(dir, withCreatedAt(oldCreated));
    await appendRun(dir, {
      sessionId: "stuck-queued",
      role: "coder",
      repo: "fake",
      status: "queued",
      startedAt: null,
      endedAt: null,
    });

    const meta = await reapStaleRunsForDir(dir);
    expect(meta).not.toBeNull();
    const run = meta!.runs[0];
    expect(run.status).toBe("stale");
    expect(run.endedAt).not.toBeNull();

    const reread = readMeta(dir);
    expect(reread!.runs[0].status).toBe("stale");
  });

  it("leaves a freshly-queued run alone (within the cutoff window)", async () => {
    const dir = join(tmp, "t_q2");
    createMeta(dir, HEADER_FRESH);
    await appendRun(dir, {
      sessionId: "fresh-queued",
      role: "coder",
      repo: "fake",
      status: "queued",
      startedAt: null,
      endedAt: null,
    });

    const meta = await reapStaleRunsForDir(dir);
    expect(meta!.runs[0].status).toBe("queued");
  });

  it("respects BRIDGE_QUEUED_STALE_MIN env override", async () => {
    process.env.BRIDGE_QUEUED_STALE_MIN = "0.01";
    const dir = join(tmp, "t_q3");
    const old = new Date(Date.now() - 30_000).toISOString();
    createMeta(dir, withCreatedAt(old));
    await appendRun(dir, {
      sessionId: "queued-via-env",
      role: "coder",
      repo: "fake",
      status: "queued",
      startedAt: null,
      endedAt: null,
    });

    const meta = await reapStaleRunsForDir(dir);
    expect(meta!.runs[0].status).toBe("stale");
  });

  it("still reaps stale running rows (registry-miss) alongside queued rows", async () => {
    const dir = join(tmp, "t_q4");
    const old = new Date(Date.now() - 10 * 60_000).toISOString();
    createMeta(dir, withCreatedAt(old));
    await appendRun(dir, {
      sessionId: "old-queued",
      role: "coder",
      repo: "fake",
      status: "queued",
      startedAt: null,
      endedAt: null,
    });
    await appendRun(dir, {
      sessionId: "old-running-no-registry",
      role: "coder",
      repo: "fake",
      status: "running",
      startedAt: new Date(Date.now() - 60 * 60_000).toISOString(),
      endedAt: null,
    });

    const meta = await reapStaleRunsForDir(dir);
    expect(meta!.runs[0].status).toBe("stale");
    expect(meta!.runs[1].status).toBe("stale");
  });

  it("does NOT flip a long-running row to stale when the process is still in the registry", async () => {
    const dir = join(tmp, "t_long_alive");
    createMeta(dir, withCreatedAt(new Date(Date.now() - 2 * 60 * 60_000).toISOString()));
    const sid = "long-alive-coordinator";
    await appendRun(dir, {
      sessionId: sid,
      role: "coordinator",
      repo: "claude-bridge",
      status: "running",
      startedAt: new Date(Date.now() - 2 * 60 * 60_000).toISOString(),
      endedAt: null,
    });
    const child = fakeChild();
    registerChild(sid, child);
    try {
      const meta = await reapStaleRunsForDir(dir);
      expect(meta!.runs[0].status).toBe("running");
      expect(meta!.runs[0].endedAt).toBeNull();
    } finally {
      unregisterChild(sid);
    }
  });

  it("flips a running row to stale immediately when the process is gone AND no JSONL exists, regardless of age", async () => {
    const dir = join(tmp, "t_gone");
    createMeta(dir, HEADER_FRESH);
    await appendRun(dir, {
      sessionId: "gone-fresh",
      role: "coder",
      repo: "fake-no-such-repo",
      status: "running",
      startedAt: new Date(Date.now() - 5_000).toISOString(),
      endedAt: null,
    });

    const meta = await reapStaleRunsForDir(dir);
    expect(meta!.runs[0].status).toBe("stale");
  });

  it("keeps a registry-miss running row alive when its JSONL was written within the cutoff", async () => {
    const dir = join(tmp, "t_external_alive");
    createMeta(dir, HEADER_FRESH);
    const sid = "0123abcd-4567-89ef-cdef-aaaaaaaaaaaa";
    await appendRun(dir, {
      sessionId: sid,
      role: "coordinator",
      repo: BRIDGE_FOLDER,
      status: "running",
      startedAt: new Date(Date.now() - 90 * 60_000).toISOString(),
      endedAt: null,
    });

    const slug = pathToSlug(BRIDGE_ROOT);
    const projectsDir = join(process.env.USERPROFILE || process.env.HOME || "", ".claude", "projects", slug);
    mkdirSync(projectsDir, { recursive: true });
    const jsonlPath = join(projectsDir, `${sid}.jsonl`);
    writeFileSync(jsonlPath, '{"type":"user","message":{"content":"hi"}}\n');
    const now = Date.now() / 1000;
    utimesSync(jsonlPath, now, now);

    try {
      const meta = await reapStaleRunsForDir(dir);
      expect(meta!.runs[0].status).toBe("running");
      expect(meta!.runs[0].endedAt).toBeNull();
    } finally {
      try { rmSync(jsonlPath, { force: true }); } catch { }
    }
  });

  it("flips a registry-miss running row to stale when its JSONL is older than the cutoff", async () => {
    const dir = join(tmp, "t_external_idle");
    createMeta(dir, HEADER_FRESH);
    const sid = "0123abcd-4567-89ef-cdef-bbbbbbbbbbbb";
    await appendRun(dir, {
      sessionId: sid,
      role: "coordinator",
      repo: BRIDGE_FOLDER,
      status: "running",
      startedAt: new Date(Date.now() - 90 * 60_000).toISOString(),
      endedAt: null,
    });

    const slug = pathToSlug(BRIDGE_ROOT);
    const projectsDir = join(process.env.USERPROFILE || process.env.HOME || "", ".claude", "projects", slug);
    mkdirSync(projectsDir, { recursive: true });
    const jsonlPath = join(projectsDir, `${sid}.jsonl`);
    writeFileSync(jsonlPath, '{"type":"user","message":{"content":"hi"}}\n');
    const old = (Date.now() - 5 * 60 * 60_000) / 1000;
    utimesSync(jsonlPath, old, old);

    try {
      const meta = await reapStaleRunsForDir(dir);
      expect(meta!.runs[0].status).toBe("stale");
    } finally {
      try { rmSync(jsonlPath, { force: true }); } catch { }
    }
  });

  it("keeps a registry-miss running row alive when a recent heartbeat was recorded, even with a stale JSONL", async () => {
    const { recordHeartbeat, _clearHeartbeatsForTest } = await import("../heartbeat");
    _clearHeartbeatsForTest();

    const dir = join(tmp, "t_heartbeat_alive");
    createMeta(dir, HEADER_FRESH);
    const sid = "deadbeef-1111-2222-3333-444455556666";
    await appendRun(dir, {
      sessionId: sid,
      role: "coordinator",
      repo: BRIDGE_FOLDER,
      status: "running",
      startedAt: new Date(Date.now() - 5 * 60 * 60_000).toISOString(),
      endedAt: null,
    });
    recordHeartbeat(sid);

    const meta = await reapStaleRunsForDir(dir);
    expect(meta!.runs[0].status).toBe("running");
    expect(meta!.runs[0].endedAt).toBeNull();

    _clearHeartbeatsForTest();
  });

  it("flips a row stale when neither heartbeat nor JSONL is fresh", async () => {
    const { _clearHeartbeatsForTest } = await import("../heartbeat");
    _clearHeartbeatsForTest();

    const dir = join(tmp, "t_heartbeat_stale");
    createMeta(dir, HEADER_FRESH);
    const sid = "feedface-aaaa-bbbb-cccc-ddddeeeeffff";
    await appendRun(dir, {
      sessionId: sid,
      role: "coder",
      repo: "fake-no-such-repo",
      status: "running",
      startedAt: new Date(Date.now() - 5 * 60 * 60_000).toISOString(),
      endedAt: null,
    });

    const meta = await reapStaleRunsForDir(dir);
    expect(meta!.runs[0].status).toBe("stale");
  });

  it("does not touch done / failed rows", async () => {
    const dir = join(tmp, "t_q5");
    const old = new Date(Date.now() - 60 * 60_000).toISOString();
    createMeta(dir, withCreatedAt(old));
    await appendRun(dir, {
      sessionId: "done-already",
      role: "coder",
      repo: "fake",
      status: "done",
      startedAt: old,
      endedAt: old,
    });
    await appendRun(dir, {
      sessionId: "failed-already",
      role: "coder",
      repo: "fake",
      status: "failed",
      startedAt: old,
      endedAt: old,
    });

    const meta = await reapStaleRunsForDir(dir);
    expect(meta!.runs[0].status).toBe("done");
    expect(meta!.runs[1].status).toBe("failed");
    expect(meta!.runs[1].endedAt).toBe(old);
  });
});

describe("reapStaleRunsForDir — repo reservation release (Task 16)", () => {
  it("releases a held repo reservation when a running row goes stale", async () => {
    const { acquireRepoReservation, currentReservation } = await import("../repoReservation");
    const dir = join(tmp, "t_reserve_stale");
    createMeta(dir, HEADER_FRESH);
    const sid = "reserve-stale-sid";
    await appendRun(dir, {
      sessionId: sid,
      role: "coder",
      repo: "fake-no-such-repo-reserve",
      status: "running",
      startedAt: new Date(Date.now() - 5_000).toISOString(),
      endedAt: null,
    });
    acquireRepoReservation("fake-no-such-repo-reserve", sid);
    expect(currentReservation("fake-no-such-repo-reserve")?.sessionId).toBe(sid);

    const meta = await reapStaleRunsForDir(dir);
    expect(meta!.runs[0].status).toBe("stale");
    expect(currentReservation("fake-no-such-repo-reserve")).toBeNull();
  });

  it("releases a held repo reservation for a queued row that goes stale", async () => {
    const { acquireRepoReservation, currentReservation } = await import("../repoReservation");
    const oldCreated = new Date(Date.now() - 5 * 60_000).toISOString();
    const dir = join(tmp, "t_reserve_queued_stale");
    createMeta(dir, withCreatedAt(oldCreated));
    const sid = "reserve-queued-stale-sid";
    await appendRun(dir, {
      sessionId: sid,
      role: "coder",
      repo: "fake-queued-reserve",
      status: "queued",
      startedAt: null,
      endedAt: null,
    });
    acquireRepoReservation("fake-queued-reserve", sid);

    const meta = await reapStaleRunsForDir(dir);
    expect(meta!.runs[0].status).toBe("stale");
    expect(currentReservation("fake-queued-reserve")).toBeNull();
  });

  it("leaves a held reservation alone when the run is not stale", async () => {
    const { acquireRepoReservation, currentReservation } = await import("../repoReservation");
    const dir = join(tmp, "t_reserve_fresh");
    createMeta(dir, HEADER_FRESH);
    const sid = "reserve-fresh-sid";
    await appendRun(dir, {
      sessionId: sid,
      role: "coder",
      repo: "fake-fresh-reserve",
      status: "queued",
      startedAt: null,
      endedAt: null,
    });
    acquireRepoReservation("fake-fresh-reserve", sid);

    const meta = await reapStaleRunsForDir(dir);
    expect(meta!.runs[0].status).toBe("queued");
    expect(currentReservation("fake-fresh-reserve")?.sessionId).toBe(sid);
  });
});
