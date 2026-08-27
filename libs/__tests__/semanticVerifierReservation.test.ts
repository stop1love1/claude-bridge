import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { join } from "node:path";

const TMP_SESSIONS = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { mkdtempSync } = require("node:fs") as typeof import("node:fs");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { tmpdir } = require("node:os") as typeof import("node:os");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { join } = require("node:path") as typeof import("node:path");
  return mkdtempSync(join(tmpdir(), "bridge-semantic-retry-reserve-"));
});

vi.mock("../paths", async () => {
  const actual = await vi.importActual<typeof import("../paths")>("../paths");
  return { ...actual, SESSIONS_DIR: TMP_SESSIONS };
});

vi.mock("../repos", async () => {
  const actual = await vi.importActual<typeof import("../repos")>("../repos");
  return { ...actual, resolveRepoCwd: () => "/tmp/fake-semantic-retry-repo" };
});

vi.mock("../coordinator", async () => {
  const actual = await vi.importActual<typeof import("../coordinator")>("../coordinator");
  return { ...actual, wireRunLifecycle: vi.fn() };
});

vi.mock("../permissionSettings", async () => {
  const actual = await vi.importActual<typeof import("../permissionSettings")>(
    "../permissionSettings",
  );
  return {
    ...actual,
    writeSessionSettings: (p: string) => p,
    freeSessionSettingsPath: (sid: string) => `settings-${sid}.json`,
  };
});

vi.mock("../promptStore", () => ({
  readOriginalPrompt: () => "",
}));

vi.mock("../retryLadder", () => ({
  checkEligibility: () => ({ eligible: true, nextAttempt: 1 }),
  maxAttemptsFor: () => 3,
  parseRole: (role: string) => ({ baseRole: role, gate: null, attempt: 0 }),
  nextRetryRole: () => "coder-svretry",
  renderStrategyPrefix: () => "PREFIX",
}));

const spawnFreeSessionMock = vi.fn();
vi.mock("../spawn", async () => {
  const actual = await vi.importActual<typeof import("../spawn")>("../spawn");
  return {
    ...actual,
    spawnFreeSession: (...args: unknown[]) => spawnFreeSessionMock(...args),
  };
});

const FAKE_APP = {
  name: "fake-semantic-app",
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

vi.mock("../apps", async () => {
  const actual = await vi.importActual<typeof import("../apps")>("../apps");
  return {
    ...actual,
    getApp: (name: string) => (name === "fake-semantic-app" ? FAKE_APP : null),
    resolvePanelSize: () => 3,
  };
});

const TASK_ID = "t_20260827_006";
const HEADER = {
  taskId: TASK_ID,
  taskTitle: "semantic-retry reservation test",
  taskBody: "",
  taskStatus: "doing" as const,
  taskSection: "DOING" as const,
  taskChecked: false,
  createdAt: "2026-08-27T10:00:00Z",
};

function taskDir() {
  return join(TMP_SESSIONS, TASK_ID);
}

const VERIFIER = {
  verdict: "broken" as const,
  reason: "does not implement the task body",
  concerns: [],
  durationMs: 1,
};

describe("spawnSemanticVerifierRetry — reservation transfer to the fresh retry session id (F1)", () => {
  beforeEach(() => {
    spawnFreeSessionMock.mockReset();
    spawnFreeSessionMock.mockImplementation(() => ({
      child: { once: () => { } },
    }));
  });

  afterEach(async () => {
    const { rmSync } = await import("node:fs");
    const { releaseRepoReservation, currentReservation } = await import("../repoReservation");
    const held = currentReservation("fake-semantic-app");
    if (held) releaseRepoReservation("fake-semantic-app", held.sessionId);
    try { rmSync(taskDir(), { recursive: true, force: true }); } catch { }
  });

  it("transfers a non-worktree app's reservation from the finished run's sessionId to the fresh retry sessionId", async () => {
    const { createMeta, appendRun } = await import("../meta");
    const { spawnSemanticVerifierRetry } = await import("../semanticVerifier");
    const { acquireRepoReservation, currentReservation } = await import("../repoReservation");

    createMeta(taskDir(), HEADER);
    const sid = "cccccccc-cccc-cccc-cccc-cccccccccccc";
    const finishedRun = {
      sessionId: sid,
      role: "coder",
      repo: "fake-semantic-app",
      status: "done" as const,
      startedAt: "2026-08-27T10:00:01Z",
      endedAt: "2026-08-27T10:00:05Z",
      parentSessionId: "parent-1",
    };
    await appendRun(taskDir(), finishedRun);

    // Mirrors production timing: postExitFlow hasn't released the original run's
    // reservation yet when the semantic gate calls spawnSemanticVerifierRetry.
    acquireRepoReservation("fake-semantic-app", sid);
    expect(currentReservation("fake-semantic-app")?.sessionId).toBe(sid);

    const result = await spawnSemanticVerifierRetry({
      taskId: TASK_ID,
      finishedRun,
      verifier: VERIFIER,
    });

    expect(result).not.toBeNull();
    expect(result!.sessionId).not.toBe(sid);
    // The reservation must now point at the NEW retry session, not the old one —
    // otherwise the retry's own eventual release (keyed by its own sessionId) can
    // never find and clear it, and the old identity's release is a no-op too.
    expect(currentReservation("fake-semantic-app")?.sessionId).toBe(result!.sessionId);
  });

  it("releases the freshly-transferred reservation when the retry spawn itself throws", async () => {
    const { createMeta, appendRun } = await import("../meta");
    const { spawnSemanticVerifierRetry } = await import("../semanticVerifier");
    const { acquireRepoReservation, currentReservation } = await import("../repoReservation");

    createMeta(taskDir(), HEADER);
    const sid = "dddddddd-dddd-dddd-dddd-dddddddddddd";
    const finishedRun = {
      sessionId: sid,
      role: "coder",
      repo: "fake-semantic-app",
      status: "done" as const,
      startedAt: "2026-08-27T10:00:01Z",
      endedAt: "2026-08-27T10:00:05Z",
      parentSessionId: "parent-1",
    };
    await appendRun(taskDir(), finishedRun);
    acquireRepoReservation("fake-semantic-app", sid);

    spawnFreeSessionMock.mockImplementation(() => {
      throw new Error("ENOENT: claude not on PATH");
    });

    const result = await spawnSemanticVerifierRetry({
      taskId: TASK_ID,
      finishedRun,
      verifier: VERIFIER,
    });

    expect(result).toBeNull();
    expect(currentReservation("fake-semantic-app")).toBeNull();
  });

  it("releases the freshly-transferred reservation when appendRun throws AFTER the child already spawned", async () => {
    const metaModule = await import("../meta");
    const { createMeta, appendRun } = metaModule;
    const { spawnSemanticVerifierRetry } = await import("../semanticVerifier");
    const { acquireRepoReservation, currentReservation } = await import("../repoReservation");

    createMeta(taskDir(), HEADER);
    const sid = "ffffffff-ffff-ffff-ffff-ffffffffffff";
    const finishedRun = {
      sessionId: sid,
      role: "coder",
      repo: "fake-semantic-app",
      status: "done" as const,
      startedAt: "2026-08-27T10:00:01Z",
      endedAt: "2026-08-27T10:00:05Z",
      parentSessionId: "parent-1",
    };
    await appendRun(taskDir(), finishedRun);
    acquireRepoReservation("fake-semantic-app", sid);

    const appendRunSpy = vi
      .spyOn(metaModule, "appendRun")
      .mockImplementationOnce(async () => {
        throw new Error("meta.json missing — task dir vanished mid-write");
      });

    const result = await spawnSemanticVerifierRetry({
      taskId: TASK_ID,
      finishedRun,
      verifier: VERIFIER,
    });

    expect(result).toBeNull();
    expect(spawnFreeSessionMock).toHaveBeenCalledTimes(1);
    // Without widening the try, this reservation would be parked forever under
    // a sessionId that has no meta row and (per its child mock) is not tracked
    // by any lifecycle wiring either.
    expect(currentReservation("fake-semantic-app")).toBeNull();

    appendRunSpy.mockRestore();
  });

  it("does not touch the reservation store for a worktree run", async () => {
    const { createMeta, appendRun } = await import("../meta");
    const { spawnSemanticVerifierRetry } = await import("../semanticVerifier");
    const { currentReservation } = await import("../repoReservation");

    createMeta(taskDir(), HEADER);
    const sid = "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee";
    const finishedRun = {
      sessionId: sid,
      role: "coder",
      repo: "fake-semantic-app",
      status: "done" as const,
      startedAt: "2026-08-27T10:00:01Z",
      endedAt: "2026-08-27T10:00:05Z",
      parentSessionId: "parent-1",
      worktreePath: "/tmp/fake-semantic-app/.worktrees/sid",
      worktreeBranch: "claude/wt/x",
      worktreeBaseBranch: "main",
    };
    await appendRun(taskDir(), finishedRun);

    const result = await spawnSemanticVerifierRetry({
      taskId: TASK_ID,
      finishedRun,
      verifier: VERIFIER,
    });

    expect(result).not.toBeNull();
    expect(currentReservation("fake-semantic-app")).toBeNull();
  });
});
