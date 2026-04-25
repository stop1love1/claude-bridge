import { describe, it, expect, beforeEach } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMeta, readMeta, appendRun, updateRun } from "../meta";

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
  it("creates, reads, appends, and updates runs", () => {
    const dir = join(tmp, "t_20260424_001");
    createMeta(dir, HEADER);

    let meta = readMeta(dir);
    expect(meta!.taskId).toBe("t_20260424_001");
    expect(meta!.taskBody).toBe("Implement /users/me endpoint.");
    expect(meta!.taskStatus).toBe("todo");
    expect(meta!.taskSection).toBe("TODO");
    expect(meta!.taskChecked).toBe(false);
    expect(meta!.runs).toEqual([]);

    appendRun(dir, { sessionId: "s1", role: "coordinator", repo: "claude-bridge", status: "queued", startedAt: null, endedAt: null });
    meta = readMeta(dir);
    expect(meta!.runs).toHaveLength(1);
    expect(meta!.runs[0].sessionId).toBe("s1");

    updateRun(dir, "s1", { status: "running", startedAt: "2026-04-24T10:00:05Z" });
    meta = readMeta(dir);
    expect(meta!.runs[0].status).toBe("running");
    expect(meta!.runs[0].startedAt).toBe("2026-04-24T10:00:05Z");
  });

  it("readMeta returns null if file does not exist", () => {
    expect(readMeta(join(tmp, "missing"))).toBeNull();
  });

  it("preserves parentSessionId through appendRun + readMeta (Phase B)", () => {
    const dir = join(tmp, "t_20260424_002");
    createMeta(dir, { ...HEADER, taskId: "t_20260424_002" });
    appendRun(dir, {
      sessionId: "child-1",
      role: "coder",
      repo: "app-web",
      status: "running",
      startedAt: "2026-04-24T11:00:00Z",
      endedAt: null,
      parentSessionId: "coordinator-1",
    });
    appendRun(dir, {
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
    // Legacy / pre-Phase-B runs have no parentSessionId field at all —
    // older meta.json files on disk must keep type-checking.
    expect(meta!.runs[1].parentSessionId).toBeUndefined();
  });
});
