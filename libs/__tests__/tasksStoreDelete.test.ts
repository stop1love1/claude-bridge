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
  return mkdtempSync(join(tmpdir(), "bridge-delete-task-"));
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

const TASK_ID = "t_20260827_001";

function taskDir() {
  return join(TMP_SESSIONS, TASK_ID);
}

describe("deleteTask — repo reservation release (Task 16 follow-up)", () => {
  afterEach(() => {
    try { rmSync(taskDir(), { recursive: true, force: true }); } catch { }
  });

  it("releases every held reservation for the deleted task's runs before the meta directory is removed", async () => {
    const { createMeta, appendRun } = await import("../meta");
    const { deleteTask } = await import("../tasksStore");
    const { registerChild } = await import("../spawnRegistry");
    const { acquireRepoReservation, currentReservation } = await import(
      "../repoReservation"
    );

    createMeta(taskDir(), {
      taskId: TASK_ID,
      taskTitle: "delete-me",
      taskBody: "",
      taskStatus: "doing",
      taskSection: "DOING",
      taskChecked: false,
      createdAt: "2026-08-27T10:00:00Z",
    });

    const sid = "delete-task-sid-1";
    await appendRun(taskDir(), {
      sessionId: sid,
      role: "coder",
      repo: "fake-delete-reserve-app",
      status: "running",
      startedAt: "2026-08-27T10:00:01Z",
      endedAt: null,
    });
    registerChild(sid, fakeChild());
    acquireRepoReservation("fake-delete-reserve-app", sid);
    expect(currentReservation("fake-delete-reserve-app")?.sessionId).toBe(sid);

    const result = await deleteTask(TASK_ID);
    expect(result.ok).toBe(true);

    expect(currentReservation("fake-delete-reserve-app")).toBeNull();
  });

  it("does not release a different session's reservation on the same repo", async () => {
    const { createMeta, appendRun } = await import("../meta");
    const { deleteTask } = await import("../tasksStore");
    const { registerChild } = await import("../spawnRegistry");
    const { acquireRepoReservation, currentReservation, releaseRepoReservation } =
      await import("../repoReservation");

    releaseRepoReservation("fake-delete-reserve-app-2", "someone-else");
    createMeta(taskDir(), {
      taskId: TASK_ID,
      taskTitle: "delete-me-2",
      taskBody: "",
      taskStatus: "doing",
      taskSection: "DOING",
      taskChecked: false,
      createdAt: "2026-08-27T10:00:00Z",
    });

    const sid = "delete-task-sid-2";
    await appendRun(taskDir(), {
      sessionId: sid,
      role: "coder",
      repo: "fake-delete-reserve-app-2",
      status: "running",
      startedAt: "2026-08-27T10:00:01Z",
      endedAt: null,
    });
    registerChild(sid, fakeChild());
    acquireRepoReservation("fake-delete-reserve-app-2", "someone-else");

    await deleteTask(TASK_ID);

    expect(currentReservation("fake-delete-reserve-app-2")?.sessionId).toBe(
      "someone-else",
    );
    releaseRepoReservation("fake-delete-reserve-app-2", "someone-else");
  });
});
