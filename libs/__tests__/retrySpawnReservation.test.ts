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
  return mkdtempSync(join(tmpdir(), "bridge-retryspawn-reserve-"));
});

vi.mock("../paths", async () => {
  const actual = await vi.importActual<typeof import("../paths")>("../paths");
  return { ...actual, SESSIONS_DIR: TMP_SESSIONS };
});

const resumeClaudeCalls: Array<{ sessionId: string }> = [];
function fakeChild(): ChildProcess {
  return new EventEmitter() as unknown as ChildProcess;
}

vi.mock("../spawn", () => ({
  resumeClaude: (_cwd: string, sessionId: string) => {
    resumeClaudeCalls.push({ sessionId });
    return fakeChild();
  },
}));

const FAKE_APP = {
  name: "fake-crash-retry-app",
  path: TMP_SESSIONS,
  git: {
    branchMode: "current" as const,
    fixedBranch: "",
    autoCommit: false,
    autoPush: false,
    worktreeMode: "disabled" as const,
    mergeTargetBranch: "",
    integrationMode: "none" as const,
  },
  verify: {},
  quality: {},
  retry: {},
  memory: {},
};

vi.mock("../apps", () => ({
  getApp: (name: string) => (name === "fake-crash-retry-app" ? FAKE_APP : null),
  loadApps: () => [FAKE_APP],
}));

const TASK_ID = "t_20260827_005";
const HEADER = {
  taskId: TASK_ID,
  taskTitle: "crash-retry reservation test",
  taskBody: "",
  taskStatus: "doing" as const,
  taskSection: "DOING" as const,
  taskChecked: false,
  createdAt: "2026-08-27T10:00:00Z",
};

function taskDir() {
  return join(TMP_SESSIONS, TASK_ID);
}

describe("spawnRetry — re-acquires the reservation the crash path already released (Important 5, crash gate)", () => {
  afterEach(() => {
    resumeClaudeCalls.length = 0;
    try { rmSync(taskDir(), { recursive: true, force: true }); } catch { }
  });

  it("re-acquires for a non-worktree app when nothing else holds it", async () => {
    const { createMeta, appendRun } = await import("../meta");
    const { spawnRetry } = await import("../retrySpawn");
    const { currentReservation, releaseRepoReservation } = await import(
      "../repoReservation"
    );

    createMeta(taskDir(), HEADER);
    const sid = "77777777-7777-7777-7777-777777777777";
    const failedRun = {
      sessionId: sid,
      role: "coder",
      repo: "fake-crash-retry-app",
      status: "failed" as const,
      startedAt: "2026-08-27T10:00:01Z",
      endedAt: "2026-08-27T10:00:02Z",
      parentSessionId: "parent-1",
    };
    await appendRun(taskDir(), failedRun);

    // Mirrors real production timing: failRun releases before tryAutoRetry ever runs,
    // so by the time spawnRetry is invoked for the crash gate, nothing is held.
    expect(currentReservation("fake-crash-retry-app")).toBeNull();

    const result = await spawnRetry({
      taskId: TASK_ID,
      finishedRun: failedRun,
      gate: "crash",
      ctxBlock: "retry context",
      logLabel: "auto-retry",
      precomputedAttempt: { nextAttempt: 1 },
    });

    expect(result).not.toBeNull();
    expect(resumeClaudeCalls).toHaveLength(1);
    expect(currentReservation("fake-crash-retry-app")?.sessionId).toBe(sid);

    releaseRepoReservation("fake-crash-retry-app", sid);
  });

  it("does not fail the retry when the reservation is held by someone else (best-effort)", async () => {
    const { createMeta, appendRun } = await import("../meta");
    const { spawnRetry } = await import("../retrySpawn");
    const {
      acquireRepoReservation,
      currentReservation,
      releaseRepoReservation,
    } = await import("../repoReservation");

    const residual = currentReservation("fake-crash-retry-app");
    if (residual) releaseRepoReservation("fake-crash-retry-app", residual.sessionId);
    createMeta(taskDir(), HEADER);
    const sid = "88888888-8888-8888-8888-888888888888";
    const failedRun = {
      sessionId: sid,
      role: "coder",
      repo: "fake-crash-retry-app",
      status: "failed" as const,
      startedAt: "2026-08-27T10:00:01Z",
      endedAt: "2026-08-27T10:00:02Z",
      parentSessionId: "parent-1",
    };
    await appendRun(taskDir(), failedRun);
    acquireRepoReservation("fake-crash-retry-app", "someone-else");

    const result = await spawnRetry({
      taskId: TASK_ID,
      finishedRun: failedRun,
      gate: "crash",
      ctxBlock: "retry context",
      logLabel: "auto-retry",
      precomputedAttempt: { nextAttempt: 1 },
    });

    expect(result).not.toBeNull();
    expect(resumeClaudeCalls).toHaveLength(1);
    expect(currentReservation("fake-crash-retry-app")?.sessionId).toBe(
      "someone-else",
    );

    releaseRepoReservation("fake-crash-retry-app", "someone-else");
  });
});
