import { describe, it, expect, vi, beforeEach } from "vitest";

const resumeSessionWithLifecycleMock = vi.fn();
vi.mock("@/libs/resumeSession", () => ({
  resumeSessionWithLifecycle: (...args: unknown[]) => resumeSessionWithLifecycleMock(...args),
}));

const spawnCoordinatorForTaskMock = vi.fn();
vi.mock("@/libs/coordinator", () => ({
  spawnCoordinatorForTask: (...args: unknown[]) => spawnCoordinatorForTaskMock(...args),
}));

const getTaskMock = vi.fn();
vi.mock("@/libs/tasksStore", () => ({
  getTask: (...args: unknown[]) => getTaskMock(...args),
}));

const readMetaMock = vi.fn();
vi.mock("@/libs/meta", () => ({
  readMeta: (...args: unknown[]) => readMetaMock(...args),
}));

vi.mock("@/libs/paths", async () => {
  const actual = await vi.importActual<typeof import("@/libs/paths")>("@/libs/paths");
  return { ...actual, BRIDGE_ROOT: "/fake/bridge-root", SESSIONS_DIR: "/fake/sessions" };
});

const FAKE_CONTINUE_APP = {
  name: "claude-bridge",
  path: "/fake/bridge-root",
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
const getAppMock = vi.fn<(name: string) => typeof FAKE_CONTINUE_APP | null>(() => null);
vi.mock("@/libs/apps", () => ({
  getApp: (name: string) => getAppMock(name),
}));

const TASK_ID = "t_20260827_201";

describe("POST /api/tasks/[id]/continue — resume settings deny Task (Task 28 follow-up)", () => {
  beforeEach(() => {
    resumeSessionWithLifecycleMock.mockClear();
    spawnCoordinatorForTaskMock.mockClear();
    getTaskMock.mockReset();
    readMetaMock.mockReset();
    getAppMock.mockReset();
    getAppMock.mockReturnValue(null);
  });

  it("threads disallowedTools:[Task] into the Continue-button resume", async () => {
    const { NextRequest } = await import("next/server");
    const { POST } = await import("../../app/api/tasks/[id]/continue/route");

    getTaskMock.mockReturnValue({ id: TASK_ID, title: "t", body: "" });
    readMetaMock.mockReturnValue({
      runs: [
        {
          sessionId: "coord-continue-route-1",
          role: "coordinator",
          repo: "claude-bridge",
          status: "done",
          startedAt: null,
          endedAt: null,
        },
      ],
    });

    const req = new NextRequest(`http://localhost/api/tasks/${TASK_ID}/continue`, {
      method: "POST",
    });
    const res = await POST(req, { params: Promise.resolve({ id: TASK_ID }) });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.action).toBe("resumed");

    expect(resumeSessionWithLifecycleMock).toHaveBeenCalledTimes(1);
    const settings = resumeSessionWithLifecycleMock.mock.calls[0][0].settings;
    expect(settings.disallowedTools).toContain("Task");
  });

  it("acquires the coordinator repo's reservation on resume and refuses a concurrent continue while held", async () => {
    const { NextRequest } = await import("next/server");
    const { POST } = await import("../../app/api/tasks/[id]/continue/route");
    const { currentReservation, releaseRepoReservation } = await import("@/libs/repoReservation");

    releaseRepoReservation("claude-bridge", "someone-else");
    getAppMock.mockReturnValue(FAKE_CONTINUE_APP);
    getTaskMock.mockReturnValue({ id: TASK_ID, title: "t", body: "" });
    readMetaMock.mockReturnValue({
      runs: [
        {
          sessionId: "coord-continue-route-2",
          role: "coordinator",
          repo: "claude-bridge",
          status: "done",
          startedAt: null,
          endedAt: null,
        },
      ],
    });

    const req = new NextRequest(`http://localhost/api/tasks/${TASK_ID}/continue`, {
      method: "POST",
    });
    const res = await POST(req, { params: Promise.resolve({ id: TASK_ID }) });

    expect(res.status).toBe(200);
    expect(currentReservation("claude-bridge")?.sessionId).toBe("coord-continue-route-2");

    releaseRepoReservation("claude-bridge", "coord-continue-route-2");
  });

  it("refuses a resume when the app is already reserved by a different session", async () => {
    const { NextRequest } = await import("next/server");
    const { POST } = await import("../../app/api/tasks/[id]/continue/route");
    const { acquireRepoReservation, currentReservation, releaseRepoReservation } =
      await import("@/libs/repoReservation");

    releaseRepoReservation("claude-bridge", "someone-else");
    acquireRepoReservation("claude-bridge", "someone-else");
    getAppMock.mockReturnValue(FAKE_CONTINUE_APP);
    getTaskMock.mockReturnValue({ id: TASK_ID, title: "t", body: "" });
    readMetaMock.mockReturnValue({
      runs: [
        {
          sessionId: "coord-continue-route-3",
          role: "coordinator",
          repo: "claude-bridge",
          status: "done",
          startedAt: null,
          endedAt: null,
        },
      ],
    });

    const req = new NextRequest(`http://localhost/api/tasks/${TASK_ID}/continue`, {
      method: "POST",
    });
    const res = await POST(req, { params: Promise.resolve({ id: TASK_ID }) });

    expect(res.status).toBe(409);
    expect(resumeSessionWithLifecycleMock).not.toHaveBeenCalled();
    expect(currentReservation("claude-bridge")?.sessionId).toBe("someone-else");

    releaseRepoReservation("claude-bridge", "someone-else");
  });

  it("releases the reservation when resumeSessionWithLifecycle itself throws", async () => {
    const { NextRequest } = await import("next/server");
    const { POST } = await import("../../app/api/tasks/[id]/continue/route");
    const { currentReservation, releaseRepoReservation } = await import("@/libs/repoReservation");

    releaseRepoReservation("claude-bridge", "someone-else");
    getAppMock.mockReturnValue(FAKE_CONTINUE_APP);
    getTaskMock.mockReturnValue({ id: TASK_ID, title: "t", body: "" });
    readMetaMock.mockReturnValue({
      runs: [
        {
          sessionId: "coord-continue-route-4",
          role: "coordinator",
          repo: "claude-bridge",
          status: "done",
          startedAt: null,
          endedAt: null,
        },
      ],
    });
    resumeSessionWithLifecycleMock.mockImplementationOnce(() => {
      throw new Error("ENOENT: claude not on PATH");
    });

    const req = new NextRequest(`http://localhost/api/tasks/${TASK_ID}/continue`, {
      method: "POST",
    });
    const res = await POST(req, { params: Promise.resolve({ id: TASK_ID }) });

    expect(res.status).toBe(500);
    expect(currentReservation("claude-bridge")).toBeNull();
  });
});
