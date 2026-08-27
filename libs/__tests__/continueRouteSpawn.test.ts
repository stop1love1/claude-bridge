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

const TASK_ID = "t_20260827_201";

describe("POST /api/tasks/[id]/continue — resume settings deny Task (Task 28 follow-up)", () => {
  beforeEach(() => {
    resumeSessionWithLifecycleMock.mockClear();
    spawnCoordinatorForTaskMock.mockClear();
    getTaskMock.mockReset();
    readMetaMock.mockReset();
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
});
