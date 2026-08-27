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
  return mkdtempSync(join(tmpdir(), "bridge-kill-route-"));
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

const TASK_ID = "t_20260827_002";
const HEADER = {
  taskId: TASK_ID,
  taskTitle: "kill-route reservation test",
  taskBody: "",
  taskStatus: "doing" as const,
  taskSection: "DOING" as const,
  taskChecked: false,
  createdAt: "2026-08-27T10:00:00Z",
};

function taskDir() {
  return join(TMP_SESSIONS, TASK_ID);
}

describe("task-scoped kill route (app/api/tasks/[id]/runs/[sessionId]/kill) — repo reservation release", () => {
  afterEach(() => {
    try { rmSync(taskDir(), { recursive: true, force: true }); } catch { }
  });

  it("releases the held reservation when the kill cancels a running run", async () => {
    const { createMeta, appendRun } = await import("../meta");
    const { registerChild } = await import("../spawnRegistry");
    const { acquireRepoReservation, currentReservation } = await import(
      "../repoReservation"
    );

    createMeta(taskDir(), HEADER);
    const sid = "11111111-1111-1111-1111-111111111111";
    await appendRun(taskDir(), {
      sessionId: sid,
      role: "coder",
      repo: "fake-kill-app-1",
      status: "running",
      startedAt: "2026-08-27T10:00:01Z",
      endedAt: null,
    });
    registerChild(sid, fakeChild());
    acquireRepoReservation("fake-kill-app-1", sid);

    const { POST } = await import(
      "@/app/api/tasks/[id]/runs/[sessionId]/kill/route"
    );
    const req = new Request(
      `http://localhost:7777/api/tasks/${TASK_ID}/runs/${sid}/kill`,
      { method: "POST" },
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await POST(req as any, {
      params: Promise.resolve({ id: TASK_ID, sessionId: sid }),
    });
    expect(res.status).toBe(200);

    expect(currentReservation("fake-kill-app-1")).toBeNull();
  });

  it("releases the held reservation even when the target run was only 'queued' (precondition misses, holder-checked release still fires)", async () => {
    const { createMeta, appendRun } = await import("../meta");
    const { registerChild } = await import("../spawnRegistry");
    const { acquireRepoReservation, currentReservation } = await import(
      "../repoReservation"
    );

    createMeta(taskDir(), HEADER);
    const sid = "22222222-2222-2222-2222-222222222222";
    await appendRun(taskDir(), {
      sessionId: sid,
      role: "coder",
      repo: "fake-kill-app-2",
      status: "queued",
      startedAt: null,
      endedAt: null,
    });
    registerChild(sid, fakeChild());
    acquireRepoReservation("fake-kill-app-2", sid);

    const { POST } = await import(
      "@/app/api/tasks/[id]/runs/[sessionId]/kill/route"
    );
    const req = new Request(
      `http://localhost:7777/api/tasks/${TASK_ID}/runs/${sid}/kill`,
      { method: "POST" },
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await POST(req as any, {
      params: Promise.resolve({ id: TASK_ID, sessionId: sid }),
    });
    expect(res.status).toBe(200);

    expect(currentReservation("fake-kill-app-2")).toBeNull();
  });

  it("does not disturb a different session's reservation on the same repo", async () => {
    const { createMeta, appendRun } = await import("../meta");
    const { registerChild } = await import("../spawnRegistry");
    const { acquireRepoReservation, currentReservation, releaseRepoReservation } =
      await import("../repoReservation");

    releaseRepoReservation("fake-kill-app-3", "someone-else");
    createMeta(taskDir(), HEADER);
    const sid = "33333333-3333-3333-3333-333333333333";
    await appendRun(taskDir(), {
      sessionId: sid,
      role: "coder",
      repo: "fake-kill-app-3",
      status: "running",
      startedAt: "2026-08-27T10:00:01Z",
      endedAt: null,
    });
    registerChild(sid, fakeChild());
    acquireRepoReservation("fake-kill-app-3", "someone-else");

    const { POST } = await import(
      "@/app/api/tasks/[id]/runs/[sessionId]/kill/route"
    );
    const req = new Request(
      `http://localhost:7777/api/tasks/${TASK_ID}/runs/${sid}/kill`,
      { method: "POST" },
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await POST(req as any, {
      params: Promise.resolve({ id: TASK_ID, sessionId: sid }),
    });

    expect(currentReservation("fake-kill-app-3")?.sessionId).toBe(
      "someone-else",
    );
    releaseRepoReservation("fake-kill-app-3", "someone-else");
  });
});

describe("session-scoped kill route (app/api/sessions/[sessionId]/kill) — repo reservation release", () => {
  afterEach(() => {
    try { rmSync(taskDir(), { recursive: true, force: true }); } catch { }
  });

  it("releases the held reservation when the kill cancels a running run found by scanning all tasks", async () => {
    const { createMeta, appendRun } = await import("../meta");
    const { registerChild } = await import("../spawnRegistry");
    const { acquireRepoReservation, currentReservation } = await import(
      "../repoReservation"
    );

    createMeta(taskDir(), HEADER);
    const sid = "44444444-4444-4444-4444-444444444444";
    await appendRun(taskDir(), {
      sessionId: sid,
      role: "coder",
      repo: "fake-kill-app-4",
      status: "running",
      startedAt: "2026-08-27T10:00:01Z",
      endedAt: null,
    });
    registerChild(sid, fakeChild());
    acquireRepoReservation("fake-kill-app-4", sid);

    const { POST } = await import("@/app/api/sessions/[sessionId]/kill/route");
    const req = new Request(`http://localhost:7777/api/sessions/${sid}/kill`, {
      method: "POST",
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await POST(req as any, {
      params: Promise.resolve({ sessionId: sid }),
    });
    expect(res.status).toBe(200);

    expect(currentReservation("fake-kill-app-4")).toBeNull();
  });
});
