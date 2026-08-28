import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createMeta,
  readMeta,
  appendRun,
  updateRun,
  applyManyRuns,
  removeSessionFromTask,
  subscribeMeta,
  type MetaChangeEvent,
} from "../meta";

let tmp: string;
beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), "meta-")); });

const HEADER = {
  taskId: "t_20260424_001",
  taskTitle: "Add /me",
  taskBody: "Implement /users/me endpoint.",
  taskStatus: "todo" as const,
  taskSection: "TODO" as const,
  taskChecked: false,
  createdAt: "2026-04-24T10:00:00Z",
};

describe("meta.ts", () => {
  it("creates, reads, appends, and updates runs", async () => {
    const dir = join(tmp, "t_20260424_001");
    createMeta(dir, HEADER);

    let meta = readMeta(dir);
    expect(meta!.taskId).toBe("t_20260424_001");
    expect(meta!.taskBody).toBe("Implement /users/me endpoint.");
    expect(meta!.taskStatus).toBe("todo");
    expect(meta!.taskSection).toBe("TODO");
    expect(meta!.taskChecked).toBe(false);
    expect(meta!.runs).toEqual([]);

    await appendRun(dir, { sessionId: "s1", role: "coordinator", repo: "claude-bridge", status: "queued", startedAt: null, endedAt: null });
    meta = readMeta(dir);
    expect(meta!.runs).toHaveLength(1);
    expect(meta!.runs[0].sessionId).toBe("s1");

    await updateRun(dir, "s1", { status: "running", startedAt: "2026-04-24T10:00:05Z" });
    meta = readMeta(dir);
    expect(meta!.runs[0].status).toBe("running");
    expect(meta!.runs[0].startedAt).toBe("2026-04-24T10:00:05Z");
  });

  it("readMeta returns null if file does not exist", () => {
    expect(readMeta(join(tmp, "missing"))).toBeNull();
  });

  it("preserves parentSessionId through appendRun + readMeta (Phase B)", async () => {
    const dir = join(tmp, "t_20260424_002");
    createMeta(dir, { ...HEADER, taskId: "t_20260424_002" });
    await appendRun(dir, {
      sessionId: "child-1",
      role: "coder",
      repo: "app-web",
      status: "running",
      startedAt: "2026-04-24T11:00:00Z",
      endedAt: null,
      parentSessionId: "coordinator-1",
    });
    await appendRun(dir, {
      sessionId: "legacy-no-parent",
      role: "coordinator",
      repo: "claude-bridge",
      status: "running",
      startedAt: "2026-04-24T11:00:00Z",
      endedAt: null,
    });

    const meta = readMeta(dir);
    expect(meta!.runs).toHaveLength(2);
    expect(meta!.runs[0].parentSessionId).toBe("coordinator-1");
    expect(meta!.runs[1].parentSessionId).toBeUndefined();
  });

  it("loses no runs under 50 concurrent appendRun calls (CRIT-2)", async () => {
    const dir = join(tmp, "t_20260424_concurrent");
    createMeta(dir, { ...HEADER, taskId: "t_20260424_concurrent" });

    const N = 50;
    const ids = Array.from({ length: N }, (_, i) => `s_${i.toString().padStart(3, "0")}`);
    await Promise.all(
      ids.map((sessionId) =>
        appendRun(dir, {
          sessionId,
          role: "coder",
          repo: "claude-bridge",
          status: "running",
          startedAt: "2026-04-24T11:00:00Z",
          endedAt: null,
        }),
      ),
    );

    const meta = readMeta(dir);
    expect(meta!.runs).toHaveLength(N);
    const present = new Set(meta!.runs.map((r) => r.sessionId));
    for (const id of ids) expect(present.has(id)).toBe(true);
  });

  it("serializes appendRun + updateRun on the same dir", async () => {
    const dir = join(tmp, "t_20260424_mixed");
    createMeta(dir, { ...HEADER, taskId: "t_20260424_mixed" });
    await appendRun(dir, {
      sessionId: "s_pre",
      role: "coordinator",
      repo: "claude-bridge",
      status: "running",
      startedAt: "2026-04-24T11:00:00Z",
      endedAt: null,
    });

    await Promise.all([
      appendRun(dir, {
        sessionId: "s_new",
        role: "coder",
        repo: "claude-bridge",
        status: "running",
        startedAt: "2026-04-24T11:00:01Z",
        endedAt: null,
      }),
      updateRun(dir, "s_pre", { status: "done", endedAt: "2026-04-24T11:00:02Z" }),
    ]);

    const meta = readMeta(dir);
    expect(meta!.runs).toHaveLength(2);
    const pre = meta!.runs.find((r) => r.sessionId === "s_pre");
    const next = meta!.runs.find((r) => r.sessionId === "s_new");
    expect(pre!.status).toBe("done");
    expect(next!.status).toBe("running");
  });

  it("applyManyRuns patches multiple runs in one write (H6)", async () => {
    const dir = join(tmp, "t_20260424_batch");
    createMeta(dir, { ...HEADER, taskId: "t_20260424_batch" });
    for (const id of ["a", "b", "c"]) {
      await appendRun(dir, {
        sessionId: id,
        role: "coder",
        repo: "claude-bridge",
        status: "running",
        startedAt: "2026-04-24T11:00:00Z",
        endedAt: null,
      });
    }

    const result = await applyManyRuns(dir, [
      { sessionId: "a", patch: { status: "failed", endedAt: "2026-04-24T12:00:00Z" } },
      { sessionId: "b", patch: { status: "done", endedAt: "2026-04-24T12:00:00Z" } },
      { sessionId: "ghost", patch: { status: "failed" } },
    ]);

    expect(result).not.toBeNull();
    const meta = readMeta(dir);
    const byId = Object.fromEntries(meta!.runs.map((r) => [r.sessionId, r]));
    expect(byId.a.status).toBe("failed");
    expect(byId.b.status).toBe("done");
    expect(byId.c.status).toBe("running");
    expect(meta!.runs).toHaveLength(3);
  });

  it("removeSessionFromTask filters runs under the lock (H7)", async () => {
    const dir = join(tmp, "t_20260424_remove");
    createMeta(dir, { ...HEADER, taskId: "t_20260424_remove" });
    await appendRun(dir, {
      sessionId: "keep",
      role: "coder",
      repo: "claude-bridge",
      status: "running",
      startedAt: "2026-04-24T11:00:00Z",
      endedAt: null,
    });
    await appendRun(dir, {
      sessionId: "drop",
      role: "coder",
      repo: "claude-bridge",
      status: "running",
      startedAt: "2026-04-24T11:00:00Z",
      endedAt: null,
    });

    const removed = await removeSessionFromTask(dir, "drop");
    expect(removed).toBe(true);

    const noop = await removeSessionFromTask(dir, "never-linked");
    expect(noop).toBe(false);

    const meta = readMeta(dir);
    expect(meta!.runs.map((r) => r.sessionId)).toEqual(["keep"]);
  });

  it("applyManyRuns skips no-op patches (review nit)", async () => {
    const dir = join(tmp, "t_20260424_noop");
    createMeta(dir, { ...HEADER, taskId: "t_20260424_noop" });
    await appendRun(dir, {
      sessionId: "already-failed",
      role: "coder",
      repo: "claude-bridge",
      status: "failed",
      startedAt: "2026-04-24T11:00:00Z",
      endedAt: "2026-04-24T11:00:30Z",
    });

    const events: MetaChangeEvent[] = [];
    const off = subscribeMeta("t_20260424_noop", (ev) => events.push(ev));
    try {
      await applyManyRuns(dir, [
        {
          sessionId: "already-failed",
          patch: { status: "failed", endedAt: "2026-04-24T11:00:30Z" },
        },
      ]);
      expect(events).toEqual([]);
    } finally {
      off();
    }
  });

  // A route reads meta once, then awaits; a concurrent write must not rewrite
  // the snapshot it is still reasoning about.
  it("does not mutate a snapshot an earlier reader is still holding", async () => {
    const dir = join(tmp, "t_20260424_alias");
    createMeta(dir, { ...HEADER, taskId: "t_20260424_alias" });
    await appendRun(dir, {
      sessionId: "s-alias",
      role: "coder",
      repo: "app-api",
      status: "running",
      startedAt: "2026-04-24T10:00:00Z",
      endedAt: null,
    });

    const snapshot = readMeta(dir)!;
    expect(snapshot.runs[0].status).toBe("running");

    await updateRun(dir, "s-alias", { status: "done", endedAt: "2026-04-24T10:05:00Z" });

    expect(snapshot.runs[0].status).toBe("running");
    expect(snapshot.runs[0].endedAt).toBeNull();
    expect(readMeta(dir)!.runs[0].status).toBe("done");
  });

  it("hands two readers independent snapshots", async () => {
    const dir = join(tmp, "t_20260424_alias2");
    createMeta(dir, { ...HEADER, taskId: "t_20260424_alias2" });
    await appendRun(dir, {
      sessionId: "s-two",
      role: "coder",
      repo: "app-api",
      status: "running",
      startedAt: null,
      endedAt: null,
    });

    const first = readMeta(dir)!;
    const second = readMeta(dir)!;
    first.runs[0].status = "failed";

    expect(second.runs[0].status).toBe("running");
    expect(readMeta(dir)!.runs[0].status).toBe("running");
  });
});
