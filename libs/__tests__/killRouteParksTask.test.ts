import { afterEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { rmSync } from "node:fs";
import { join } from "node:path";
import type { ChildProcess } from "node:child_process";

const TMP_SESSIONS = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { mkdtempSync } = require("node:fs") as typeof import("node:fs");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { tmpdir } = require("node:os") as typeof import("node:os");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { join } = require("node:path") as typeof import("node:path");
  return mkdtempSync(join(tmpdir(), "bridge-kill-parks-"));
});

vi.mock("../paths", async () => {
  const actual = await vi.importActual<typeof import("../paths")>("../paths");
  return { ...actual, SESSIONS_DIR: TMP_SESSIONS };
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

const TASK_ID = "t_20260904_007";
const COORD = "69c26ad8-5edf-40d4-b745-9f19e73a28a7";
const HEADER = {
  taskId: TASK_ID,
  taskTitle: "kill parks task test",
  taskBody: "",
  taskStatus: "doing" as const,
  taskSection: "DOING" as const,
  taskChecked: false,
  createdAt: "2026-09-04T15:19:03.074Z",
};
const taskDir = () => join(TMP_SESSIONS, TASK_ID);

async function seedRunningCoordinator() {
  const { createMeta, appendRun } = await import("../meta");
  const { registerChild } = await import("../spawnRegistry");
  createMeta(taskDir(), HEADER);
  await appendRun(taskDir(), {
    sessionId: COORD,
    role: "coordinator",
    repo: "claude-bridge",
    status: "running",
    startedAt: "2026-09-04T15:19:03.320Z",
    endedAt: null,
  });
  registerChild(COORD, fakeChild());
}

describe("killing a lone coordinator parks the task out of DOING", () => {
  afterEach(() => {
    try { rmSync(taskDir(), { recursive: true, force: true }); } catch { }
  });

  it("task-scoped kill route moves the task to TODO and reports it", async () => {
    await seedRunningCoordinator();
    const { POST } = await import("@/app/api/tasks/[id]/runs/[sessionId]/kill/route");
    const req = new Request(`http://localhost:7777/api/tasks/${TASK_ID}/runs/${COORD}/kill`, { method: "POST" });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await POST(req as any, { params: Promise.resolve({ id: TASK_ID, sessionId: COORD }) });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ action: "killed", parkedIn: "TODO" });

    const { readMeta } = await import("../meta");
    const meta = readMeta(taskDir());
    expect(meta?.runs[0].status).toBe("cancelled");
    expect(meta?.taskSection).toBe("TODO");
  });

  it("session-scoped kill route does the same", async () => {
    await seedRunningCoordinator();
    const { POST } = await import("@/app/api/sessions/[sessionId]/kill/route");
    const req = new Request(`http://localhost:7777/api/sessions/${COORD}/kill`, { method: "POST" });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await POST(req as any, { params: Promise.resolve({ sessionId: COORD }) });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ action: "killed", parkedIn: "TODO" });

    const { readMeta } = await import("../meta");
    expect(readMeta(taskDir())?.taskSection).toBe("TODO");
  });
});
