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

const resumeClaudeCalls: Array<{ sessionId: string; settings?: { disallowedTools?: string[] } }> = [];
function fakeChild(): ChildProcess {
  return new EventEmitter() as unknown as ChildProcess;
}

vi.mock("../spawn", () => ({
  resumeClaude: (
    _cwd: string,
    sessionId: string,
    _message: string,
    settings?: { disallowedTools?: string[] },
  ) => {
    resumeClaudeCalls.push({ sessionId, settings });
    return fakeChild();
  },
  denyTaskToolNames: () => ["Task"],
}));

const writeSessionSettingsShouldThrow = vi.hoisted(() => ({ value: false }));

vi.mock("../permissionSettings", async () => {
  const actual = await vi.importActual<typeof import("../permissionSettings")>(
    "../permissionSettings",
  );
  return {
    ...actual,
    writeSessionSettings: (file: string) => {
      if (writeSessionSettingsShouldThrow.value) {
        throw new Error("EACCES: simulated permission-store write failure");
      }
      return actual.writeSessionSettings(file);
    },
  };
});

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
    writeSessionSettingsShouldThrow.value = false;
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
    expect(resumeClaudeCalls[0].settings?.disallowedTools).toContain("Task");

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

  it("releases the freshly re-acquired reservation when writeSessionSettings throws (crash gate, no wireRunLifecycle backstop above)", async () => {
    const { createMeta, appendRun } = await import("../meta");
    const { spawnRetry } = await import("../retrySpawn");
    const { currentReservation, releaseRepoReservation } = await import(
      "../repoReservation"
    );

    const residual = currentReservation("fake-crash-retry-app");
    if (residual) releaseRepoReservation("fake-crash-retry-app", residual.sessionId);
    createMeta(taskDir(), HEADER);
    const sid = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
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

    writeSessionSettingsShouldThrow.value = true;
    const result = await spawnRetry({
      taskId: TASK_ID,
      finishedRun: failedRun,
      gate: "crash",
      ctxBlock: "retry context",
      logLabel: "auto-retry",
      precomputedAttempt: { nextAttempt: 1 },
    });

    expect(result).toBeNull();
    expect(resumeClaudeCalls).toHaveLength(0);
    expect(currentReservation("fake-crash-retry-app")).toBeNull();
  });

  it("is an idempotent no-op when a postExitFlow-triggered gate spawns a retry that still holds its own reservation", async () => {
    const { createMeta, appendRun } = await import("../meta");
    const { spawnRetry } = await import("../retrySpawn");
    const repoReservation = await import("../repoReservation");
    const { acquireRepoReservation, currentReservation, releaseRepoReservation } =
      repoReservation;
    const acquireSpy = vi.spyOn(repoReservation, "acquireRepoReservation");

    const residual = currentReservation("fake-crash-retry-app");
    if (residual) releaseRepoReservation("fake-crash-retry-app", residual.sessionId);
    createMeta(taskDir(), HEADER);
    const sid = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
    const finishedRun = {
      sessionId: sid,
      role: "coder",
      repo: "fake-crash-retry-app",
      status: "done" as const,
      startedAt: "2026-08-27T10:00:01Z",
      endedAt: "2026-08-27T10:00:05Z",
      parentSessionId: "parent-1",
    };
    await appendRun(taskDir(), finishedRun);

    // Mirrors the identityRetained property: by the time a postExitFlow gate (verify,
    // preflight, claim, style) reaches spawnRetry, the original postExitFlow run's own
    // reservation is still held under this exact sessionId — it was never released.
    acquireRepoReservation("fake-crash-retry-app", sid);
    expect(currentReservation("fake-crash-retry-app")?.sessionId).toBe(sid);

    const result = await spawnRetry({
      taskId: TASK_ID,
      finishedRun,
      gate: "verify",
      ctxBlock: "verify failure context",
      logLabel: "verify-retry",
      precomputedAttempt: { nextAttempt: 1 },
    });

    expect(result).not.toBeNull();
    expect(resumeClaudeCalls).toHaveLength(1);
    // Pin that spawnRetry actually called acquireRepoReservation for this session (not
    // that the outcome merely looks unchanged) and that the call reported success.
    expect(acquireSpy).toHaveBeenCalledWith("fake-crash-retry-app", sid);
    expect(acquireSpy.mock.results[0]?.value).toEqual({ ok: true });
    // Still held by the SAME session — the re-acquire was a harmless idempotent no-op,
    // not a second reservation and not a release.
    expect(currentReservation("fake-crash-retry-app")?.sessionId).toBe(sid);

    acquireSpy.mockRestore();
    releaseRepoReservation("fake-crash-retry-app", sid);
  });
});
