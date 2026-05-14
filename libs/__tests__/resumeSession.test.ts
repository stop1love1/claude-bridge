import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChildProcess } from "node:child_process";

/**
 * `resumeSessionWithLifecycle` is the helper the bridge uses when
 * /api/tasks/<id>/continue or /api/sessions/<sid>/message wakes an
 * existing Claude session back up. The bug it fixes: the legacy
 * call-sites used raw `resumeClaude` and forgot to flip the run row
 * `done|failed → running` + wire the new process's lifecycle, so the UI
 * showed a stale "DONE" badge while the coordinator was actively
 * streaming a reply.
 *
 * We mock `resumeClaude` (the spawn boundary), `findTaskBySessionId`
 * (the meta lookup), and the `meta` write helpers, and assert:
 *
 *   1. When the sessionId belongs to a task whose meta has a matching
 *      run row → updateRun was called with status:"running" + cleared
 *      endedAt + fresh startedAt, AND wireRunLifecycle was called.
 *   2. When the sessionId is for a free chat (no owning task) →
 *      neither updateRun nor wireRunLifecycle fires; the resume still
 *      goes through.
 */

const fakeChild = {
  on: () => {
    /* noop */
  },
  once: () => {
    /* noop */
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

// `findTaskBySessionId` is the seam: returning a fake task drives the
// meta-update branch; returning null drives the free-chat branch.
let owningTask: { id: string } | null = null;
vi.mock("../tasksStore", () => ({
  findTaskBySessionId: () => owningTask,
}));

// Synthetic meta with a matching run row. The helper calls readMeta to
// confirm the row exists before flipping status.
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

    // Drain the microtask queue so the void-Promise updateRun call
    // settles before we inspect.
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
