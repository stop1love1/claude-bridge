import { afterEach, describe, expect, it, vi } from "vitest";
import { rmSync } from "node:fs";
import { join } from "node:path";

const TMP_SESSIONS = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { mkdtempSync } = require("node:fs") as typeof import("node:fs");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { tmpdir } = require("node:os") as typeof import("node:os");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { join } = require("node:path") as typeof import("node:path");
  return mkdtempSync(join(tmpdir(), "bridge-settle-kill-"));
});

vi.mock("../paths", async () => {
  const actual = await vi.importActual<typeof import("../paths")>("../paths");
  return { ...actual, SESSIONS_DIR: TMP_SESSIONS };
});

const TASK_ID = "t_20260904_007";
const COORD = "69c26ad8-5edf-40d4-b745-9f19e73a28a7";
const CHILD = "22222222-2222-2222-2222-222222222222";

function header(section: "TODO" | "DOING" | "BLOCKED" = "DOING") {
  return {
    taskId: TASK_ID,
    taskTitle: "settle-after-kill test",
    taskBody: "",
    taskStatus: section === "DOING" ? ("doing" as const) : section === "TODO" ? ("todo" as const) : ("blocked" as const),
    taskSection: section,
    taskChecked: false,
    createdAt: "2026-09-04T15:19:03.074Z",
  };
}

const dir = () => join(TMP_SESSIONS, TASK_ID);

async function seed(
  section: "TODO" | "DOING" | "BLOCKED",
  runs: Array<{ sessionId: string; role: string; status: "queued" | "running" | "done" | "failed" | "cancelled" | "stale" }>,
) {
  const { createMeta, appendRun } = await import("../meta");
  createMeta(dir(), header(section));
  for (const r of runs) {
    await appendRun(dir(), {
      sessionId: r.sessionId,
      role: r.role,
      repo: "claude-bridge",
      status: r.status,
      startedAt: "2026-09-04T15:19:03.320Z",
      endedAt: r.status === "running" || r.status === "queued" ? null : "2026-09-04T15:19:27.244Z",
    });
  }
}

describe("settleTaskAfterKill", () => {
  afterEach(() => {
    try { rmSync(dir(), { recursive: true, force: true }); } catch { }
  });

  it("parks a DOING task back in TODO when its only run was the coordinator and it got killed", async () => {
    // Regression: t_20260904_007 — coordinator killed 24s in, before any
    // child was dispatched; the task sat in DOING with nothing alive.
    await seed("DOING", [{ sessionId: COORD, role: "coordinator", status: "cancelled" }]);
    const { settleTaskAfterKill } = await import("../settleTaskAfterKill");
    const { readMeta } = await import("../meta");

    const moved = await settleTaskAfterKill(TASK_ID);

    expect(moved).toBe("TODO");
    expect(readMeta(dir())?.taskSection).toBe("TODO");
    expect(readMeta(dir())?.taskStatus).toBe("todo");
  });

  it("parks in BLOCKED when children had already been dispatched", async () => {
    await seed("DOING", [
      { sessionId: COORD, role: "coordinator", status: "cancelled" },
      { sessionId: CHILD, role: "coder", status: "done" },
    ]);
    const { settleTaskAfterKill } = await import("../settleTaskAfterKill");
    const { readMeta } = await import("../meta");

    expect(await settleTaskAfterKill(TASK_ID)).toBe("BLOCKED");
    expect(readMeta(dir())?.taskSection).toBe("BLOCKED");
  });

  it("leaves the task alone while any run is still live", async () => {
    await seed("DOING", [
      { sessionId: COORD, role: "coordinator", status: "running" },
      { sessionId: CHILD, role: "coder", status: "cancelled" },
    ]);
    const { settleTaskAfterKill } = await import("../settleTaskAfterKill");
    const { readMeta } = await import("../meta");

    expect(await settleTaskAfterKill(TASK_ID)).toBeNull();
    expect(readMeta(dir())?.taskSection).toBe("DOING");
  });

  it("leaves the task alone when the coordinator finished normally (READY FOR REVIEW stays in DOING)", async () => {
    await seed("DOING", [
      { sessionId: COORD, role: "coordinator", status: "done" },
      { sessionId: CHILD, role: "coder", status: "cancelled" },
    ]);
    const { settleTaskAfterKill } = await import("../settleTaskAfterKill");
    const { readMeta } = await import("../meta");

    expect(await settleTaskAfterKill(TASK_ID)).toBeNull();
    expect(readMeta(dir())?.taskSection).toBe("DOING");
  });

  it("only acts on DOING tasks", async () => {
    await seed("TODO", [{ sessionId: COORD, role: "coordinator", status: "cancelled" }]);
    const { settleTaskAfterKill } = await import("../settleTaskAfterKill");
    const { readMeta } = await import("../meta");

    expect(await settleTaskAfterKill(TASK_ID)).toBeNull();
    expect(readMeta(dir())?.taskSection).toBe("TODO");
  });

  it("returns null for an unknown task", async () => {
    const { settleTaskAfterKill } = await import("../settleTaskAfterKill");
    expect(await settleTaskAfterKill("t_20260101_999")).toBeNull();
  });
});
