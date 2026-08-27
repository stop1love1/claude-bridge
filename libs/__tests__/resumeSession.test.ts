import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChildProcess } from "node:child_process";


const fakeChild = {
  on: () => {
  },
  once: () => {
  },
} as unknown as ChildProcess;

const resumeClaudeCalls: Array<{
  cwd: string;
  sessionId: string;
  message: string;
}> = [];
const updateRunCalls: Array<{ sessionId: string; patch: Record<string, unknown> }> = [];
const wireLifecycleCalls: Array<{ sessionId: string; context: string | undefined }> = [];

vi.mock("../spawn", () => ({
  resumeClaude: (cwd: string, sessionId: string, message: string) => {
    resumeClaudeCalls.push({ cwd, sessionId, message });
    return fakeChild;
  },
}));

vi.mock("../runLifecycle", () => ({
  wireRunLifecycle: (
    _dir: string,
    sessionId: string,
    _child: ChildProcess,
    context?: string,
  ) => {
    wireLifecycleCalls.push({ sessionId, context });
  },
}));

let owningTask: { id: string } | null = null;
vi.mock("../tasksStore", () => ({
  findTaskBySessionId: () => owningTask,
}));

const SID_OWNED = "11111111-2222-3333-4444-555555555555";
const SID_UNKNOWN = "99999999-2222-3333-4444-555555555555";
vi.mock("../meta", () => ({
  readMeta: () => ({
    runs: [
      {
        sessionId: SID_OWNED,
        role: "coordinator",
        repo: "claude-bridge",
        status: "done",
        startedAt: "2026-05-14T10:00:00Z",
        endedAt: "2026-05-14T10:00:30Z",
      },
    ],
  }),
  updateRun: (_dir: string, sessionId: string, patch: Record<string, unknown>) => {
    updateRunCalls.push({ sessionId, patch });
    return Promise.resolve({ applied: true, run: null });
  },
}));

beforeEach(() => {
  resumeClaudeCalls.length = 0;
  updateRunCalls.length = 0;
  wireLifecycleCalls.length = 0;
  owningTask = null;
  vi.resetModules();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("resumeSessionWithLifecycle", () => {
  it("flips meta status running + wires lifecycle when sessionId belongs to a task", async () => {
    owningTask = { id: "t_20260514_001" };
    const { resumeSessionWithLifecycle } = await import("../resumeSession");

    const child = resumeSessionWithLifecycle({
      cwd: "/tmp/bridge",
      sessionId: SID_OWNED,
      message: "continue please",
      settings: { mode: "bypassPermissions" },
      context: "test-resume",
    });

    expect(child).toBe(fakeChild);
    expect(resumeClaudeCalls).toHaveLength(1);
    expect(resumeClaudeCalls[0].sessionId).toBe(SID_OWNED);

    await Promise.resolve();
    await Promise.resolve();

    expect(updateRunCalls).toHaveLength(1);
    expect(updateRunCalls[0].sessionId).toBe(SID_OWNED);
    expect(updateRunCalls[0].patch.status).toBe("running");
    expect(updateRunCalls[0].patch.endedAt).toBeNull();
    expect(typeof updateRunCalls[0].patch.startedAt).toBe("string");

    expect(wireLifecycleCalls).toHaveLength(1);
    expect(wireLifecycleCalls[0].sessionId).toBe(SID_OWNED);
    expect(wireLifecycleCalls[0].context).toBe("test-resume");
  });

  it("falls through to a plain resume (no meta touch) when sessionId has no owning task", async () => {
    owningTask = null;
    const { resumeSessionWithLifecycle } = await import("../resumeSession");

    const child = resumeSessionWithLifecycle({
      cwd: "/tmp/bridge",
      sessionId: SID_UNKNOWN,
      message: "free-chat turn",
    });

    expect(child).toBe(fakeChild);
    expect(resumeClaudeCalls).toHaveLength(1);
    expect(resumeClaudeCalls[0].sessionId).toBe(SID_UNKNOWN);

    await Promise.resolve();
    await Promise.resolve();

    expect(updateRunCalls).toHaveLength(0);
    expect(wireLifecycleCalls).toHaveLength(0);
  });
});
