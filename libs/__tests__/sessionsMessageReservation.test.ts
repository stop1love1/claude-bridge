import { afterEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import type { EarlyFailure } from "../spawn";

const TMP_SESSIONS = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { mkdtempSync } = require("node:fs") as typeof import("node:fs");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { tmpdir } = require("node:os") as typeof import("node:os");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { join } = require("node:path") as typeof import("node:path");
  return mkdtempSync(join(tmpdir(), "bridge-message-reserve-"));
});

const TMP_PROJECT_DIR = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { mkdtempSync } = require("node:fs") as typeof import("node:fs");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { tmpdir } = require("node:os") as typeof import("node:os");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { join } = require("node:path") as typeof import("node:path");
  return mkdtempSync(join(tmpdir(), "bridge-message-project-"));
});

vi.mock("../paths", async () => {
  const actual = await vi.importActual<typeof import("../paths")>("../paths");
  return { ...actual, SESSIONS_DIR: TMP_SESSIONS };
});

vi.mock("../auth", () => ({
  verifyRequestActor: () => null,
}));

vi.mock("../sessions", () => ({
  projectDirFor: () => TMP_PROJECT_DIR,
}));

vi.mock("../sessionEvents", () => ({
  isAlive: () => false,
}));

vi.mock("../guestSessionRepo", () => ({
  guestBoundRepoValue: (args: { callerValue: string | null }) => args.callerValue,
}));

vi.mock("../repos", () => ({
  resolveRepoCwd: () => "/tmp/fake-message-repo",
}));

vi.mock("../permissionSettings", () => ({
  writeSessionSettings: (p: string) => p,
  freeSessionSettingsPath: (sid: string) => `settings-${sid}.json`,
}));

const owningTaskRef: { value: { id: string; checked: boolean; section: string } | null } =
  vi.hoisted(() => ({ value: null }));

vi.mock("../tasksStore", () => ({
  findTaskBySessionId: () => owningTaskRef.value,
  updateTask: vi.fn(),
}));

function fakeChild(): ChildProcess & { emit: (ev: string, ...args: unknown[]) => boolean } {
  const ee = new EventEmitter();
  return ee as unknown as ChildProcess & { emit: (ev: string, ...args: unknown[]) => boolean };
}

const resumedChildren: ReturnType<typeof fakeChild>[] = [];
const spawnedChildren: ReturnType<typeof fakeChild>[] = [];

const waitEarlyFailureMock = vi.fn<
  (child: ChildProcess, windowMs?: number) => Promise<EarlyFailure | null>
>(async () => null);

vi.mock("../spawn", () => ({
  resumeClaude: () => {
    const c = fakeChild();
    resumedChildren.push(c);
    return c;
  },
  spawnFreeSession: (
    _cwd: string,
    _prompt: string,
    _settings: unknown,
    _settingsPath: string,
    sessionId: string,
  ) => {
    const c = fakeChild();
    spawnedChildren.push(c);
    return { child: c, sessionId };
  },
  waitEarlyFailure: (...args: [ChildProcess, number?]) => waitEarlyFailureMock(...args),
}));

const FAKE_APP = {
  name: "fake-message-app",
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
  getApp: (name: string) => (name === "fake-message-app" ? FAKE_APP : null),
  isValidAppName: (name?: string) => typeof name === "string" && name.length > 0,
  loadApps: () => [FAKE_APP],
}));

async function postMessage(sessionId: string, body: Record<string, unknown>) {
  const { POST } = await import("@/app/api/sessions/[sessionId]/message/route");
  const req = new Request(`http://localhost:7777/api/sessions/${sessionId}/message`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return POST(req as any, { params: Promise.resolve({ sessionId }) });
}

async function flushAsync(times = 5): Promise<void> {
  for (let i = 0; i < times; i++) {
    await new Promise((r) => setImmediate(r));
  }
}

describe("sessions/[sessionId]/message — repo reservation + atomic claim (F3)", () => {
  afterEach(async () => {
    resumedChildren.length = 0;
    spawnedChildren.length = 0;
    waitEarlyFailureMock.mockReset();
    waitEarlyFailureMock.mockImplementation(async () => null);
    owningTaskRef.value = null;
    const { releaseRepoReservation, currentReservation } = await import("../repoReservation");
    const held = currentReservation("fake-message-app");
    if (held) releaseRepoReservation("fake-message-app", held.sessionId);
  });

  it("acquires the app's reservation on a fresh dispatch and refuses a concurrent dispatch to the same app", async () => {
    const { currentReservation } = await import("../repoReservation");
    const sidA = "11111111-1111-1111-1111-111111111111";
    const sidB = "22222222-2222-2222-2222-222222222222";

    const res1 = await postMessage(sidA, { message: "hello", repo: "fake-message-app" });
    expect(res1.status).toBe(200);
    expect(currentReservation("fake-message-app")?.sessionId).toBe(sidA);
    expect(spawnedChildren).toHaveLength(1);

    const res2 = await postMessage(sidB, { message: "hello", repo: "fake-message-app" });
    expect(res2.status).toBe(409);
    const body2 = (await res2.json()) as { error: string; heldBy: string | null };
    expect(body2.error).toBe("repo reserved");
    expect(body2.heldBy).toBe(sidA);
    expect(spawnedChildren).toHaveLength(1);

    spawnedChildren[0].emit("exit", 0, null);
    await flushAsync();
    expect(currentReservation("fake-message-app")).toBeNull();

    const res3 = await postMessage(sidB, { message: "hello", repo: "fake-message-app" });
    expect(res3.status).toBe(200);
    expect(currentReservation("fake-message-app")?.sessionId).toBe(sidB);
    spawnedChildren[1].emit("exit", 0, null);
    await flushAsync();
  });

  it("releases the reservation on the dispatch-throw path", async () => {
    const { currentReservation } = await import("../repoReservation");
    const spawnMod = await import("../spawn");
    const spawnSpy = vi.spyOn(spawnMod, "spawnFreeSession").mockImplementationOnce(() => {
      throw new Error("ENOENT: claude not on PATH");
    });

    const sid = "33333333-3333-3333-3333-333333333333";
    const res = await postMessage(sid, { message: "hello", repo: "fake-message-app" });
    expect(res.status).toBe(500);
    expect(currentReservation("fake-message-app")).toBeNull();

    spawnSpy.mockRestore();
  });

  it("releases the reservation when the spawned child emits 'error' without ever emitting 'exit' (untracked free session)", async () => {
    const { currentReservation } = await import("../repoReservation");

    const sid = "77777777-7777-7777-7777-777777777777";
    const res = await postMessage(sid, { message: "hello", repo: "fake-message-app" });
    expect(res.status).toBe(200);
    expect(spawnedChildren).toHaveLength(1);
    expect(currentReservation("fake-message-app")?.sessionId).toBe(sid);

    // Node emits 'error' without 'exit' when the process itself could not be
    // spawned (ENOENT, exec format, ...) — attachQueueDrain must not depend on
    // 'exit' alone to release, or this reservation is stuck forever for a
    // session that was never wired to any other lifecycle.
    spawnedChildren[0].emit("error", new Error("ENOENT: claude not on PATH"));
    await flushAsync();

    expect(currentReservation("fake-message-app")).toBeNull();
  });

  it("rejects a second concurrent POST for the SAME sessionId while the first is still in flight (atomic claim)", async () => {
    let resolveWait: (v: EarlyFailure | null) => void = () => {};
    const stuck = new Promise<EarlyFailure | null>((resolve) => { resolveWait = resolve; });
    waitEarlyFailureMock.mockReset();
    waitEarlyFailureMock.mockImplementationOnce(() => stuck);
    waitEarlyFailureMock.mockImplementation(async () => null);

    const sid = "44444444-4444-4444-4444-444444444444";
    const p1 = postMessage(sid, { message: "first", repo: "fake-message-app" });
    await flushAsync(3);

    const res2 = await postMessage(sid, { message: "second", repo: "fake-message-app" });
    expect(res2.status).toBe(409);
    const body2 = (await res2.json()) as { error: string };
    expect(body2.error).toMatch(/already in flight/);

    resolveWait(null);
    const res1 = await p1;
    expect(res1.status).toBe(200);

    expect(spawnedChildren).toHaveLength(1);
    spawnedChildren[0].emit("exit", 0, null);
    await flushAsync();
  });

  it("blocks a fresh dispatch into a tracked task whose plan is not yet approved (plan-gate)", async () => {
    const { createMeta, appendRun, setIntake } = await import("../meta");
    const { _resetForTests } = await import("../planGateConfig");
    const { currentReservation } = await import("../repoReservation");
    _resetForTests();

    const taskId = "t_20260827_090";
    const dir = `${TMP_SESSIONS}/${taskId}`;
    createMeta(dir, {
      taskId,
      taskTitle: "plan-gate probe",
      taskBody: "",
      taskStatus: "doing" as const,
      taskSection: "DOING" as const,
      taskChecked: false,
      createdAt: "2026-08-27T10:00:00Z",
    });
    const sid = "55555555-5555-5555-5555-555555555555";
    await appendRun(dir, {
      sessionId: sid,
      role: "coder",
      repo: "fake-message-app",
      status: "done" as const,
      startedAt: "2026-08-27T09:00:00Z",
      endedAt: "2026-08-27T09:05:00Z",
    });
    await setIntake(dir, { status: "planning", submittedBy: { kind: "operator", label: "operator" } });

    owningTaskRef.value = { id: taskId, checked: false, section: "DOING" };

    const res = await postMessage(sid, { message: "keep going", repo: "fake-message-app" });
    expect(res.status).toBe(423);
    const body = (await res.json()) as { error: string; intakeStatus: string };
    expect(body.error).toBe("plan-gate");
    expect(body.intakeStatus).toBe("planning");
    expect(spawnedChildren).toHaveLength(0);
    expect(currentReservation("fake-message-app")).toBeNull();
  });

  it("does NOT plan-gate a resume of an existing conversation, even when the task's plan is not approved", async () => {
    const { writeFileSync } = await import("node:fs");
    const { createMeta, appendRun, setIntake } = await import("../meta");
    const { _resetForTests } = await import("../planGateConfig");
    const { currentReservation } = await import("../repoReservation");
    _resetForTests();

    const taskId = "t_20260827_091";
    const dir = `${TMP_SESSIONS}/${taskId}`;
    createMeta(dir, {
      taskId,
      taskTitle: "plan-gate resume probe",
      taskBody: "",
      taskStatus: "doing" as const,
      taskSection: "DOING" as const,
      taskChecked: false,
      createdAt: "2026-08-27T10:00:00Z",
    });
    const sid = "66666666-6666-6666-6666-666666666666";
    await appendRun(dir, {
      sessionId: sid,
      role: "coder",
      repo: "fake-message-app",
      status: "done" as const,
      startedAt: "2026-08-27T09:00:00Z",
      endedAt: "2026-08-27T09:05:00Z",
    });
    await setIntake(dir, { status: "planning", submittedBy: { kind: "operator", label: "operator" } });

    owningTaskRef.value = { id: taskId, checked: false, section: "DOING" };
    writeFileSync(`${TMP_PROJECT_DIR}/${sid}.jsonl`, "");

    const res = await postMessage(sid, { message: "keep going", repo: "fake-message-app" });
    expect(res.status).toBe(200);
    expect(resumedChildren).toHaveLength(1);
    expect(currentReservation("fake-message-app")?.sessionId).toBe(sid);

    resumedChildren[0].emit("exit", 0, null);
    await flushAsync();
  });
});
