import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { rmSync } from "node:fs";
import { join } from "node:path";

const TMP_SESSIONS = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { mkdtempSync } = require("node:fs") as typeof import("node:fs");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { tmpdir } = require("node:os") as typeof import("node:os");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { join } = require("node:path") as typeof import("node:path");
  return mkdtempSync(join(tmpdir(), "bridge-manual-dispatch-"));
});

vi.mock("../paths", async () => {
  const actual = await vi.importActual<typeof import("../paths")>("../paths");
  return { ...actual, SESSIONS_DIR: TMP_SESSIONS };
});

const spawnMock = vi.hoisted(() => vi.fn<(task: { id: string }) => Promise<string | null>>());
vi.mock("../coordinator", () => ({
  spawnCoordinatorForTask: (task: { id: string }) => spawnMock(task),
}));

const gateState = vi.hoisted(() => ({ operatorEnabled: true }));
vi.mock("../planGateConfig", () => ({
  readPlanGateConfig: () => ({ operatorEnabled: gateState.operatorEnabled }),
}));

import { createTask, getTask, listTasks, updateTask } from "../tasksStore";
import { appendRun, readMeta } from "../meta";
import { dispatchTodoTask } from "../dispatchTodoTask";
import { dueScheduledTasks, scheduledStartTick } from "../scheduledStart";

const NOW = Date.parse("2026-09-05T02:00:00.000Z");
const LATER = new Date(NOW + 60 * 60_000).toISOString();
const EARLIER = new Date(NOW - 60_000).toISOString();

function wipe() {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { readdirSync } = require("node:fs") as typeof import("node:fs");
  for (const id of readdirSync(TMP_SESSIONS)) {
    try { rmSync(join(TMP_SESSIONS, id), { recursive: true, force: true }); } catch { }
  }
}

describe("manual dispatch — data layer", () => {
  beforeEach(() => { spawnMock.mockReset(); wipe(); });
  afterEach(wipe);

  it("createTask records dispatch=manual and scheduledAt in meta and on the Task", () => {
    const t = createTask({ title: "draft", body: "draft", dispatch: "manual", scheduledAt: LATER });
    expect(t.section).toBe("TODO");
    expect(t.dispatch).toBe("manual");
    expect(t.scheduledAt).toBe(LATER);
    const meta = readMeta(join(TMP_SESSIONS, t.id));
    expect(meta?.dispatch).toBe("manual");
    expect(meta?.scheduledAt).toBe(LATER);
    expect(getTask(t.id)?.scheduledAt).toBe(LATER);
  });

  it("tasks created the old way read as dispatch=immediate with no schedule", () => {
    const t = createTask({ title: "x", body: "x" });
    expect(t.dispatch).toBe("immediate");
    expect(t.scheduledAt).toBeNull();
  });

  it("updateTask can set and clear scheduledAt", async () => {
    const t = createTask({ title: "x", body: "x", dispatch: "manual" });
    const set = await updateTask(t.id, { scheduledAt: LATER });
    expect(set?.scheduledAt).toBe(LATER);
    const cleared = await updateTask(t.id, { scheduledAt: null });
    expect(cleared?.scheduledAt).toBeNull();
    expect(readMeta(join(TMP_SESSIONS, t.id))?.scheduledAt).toBeNull();
  });
});

describe("dispatchTodoTask", () => {
  beforeEach(() => { spawnMock.mockReset(); wipe(); });
  afterEach(wipe);

  it("spawns a coordinator for a waiting task and clears its schedule", async () => {
    spawnMock.mockResolvedValue("sid-1");
    const t = createTask({ title: "x", body: "x", dispatch: "manual", scheduledAt: LATER });

    const r = await dispatchTodoTask(t.id);

    expect(r).toEqual({ action: "spawned", sessionId: "sid-1" });
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(spawnMock.mock.calls[0][0].id).toBe(t.id);
    expect(getTask(t.id)?.scheduledAt).toBeNull();
  });

  it("also works once the UI has already dragged the card into DOING", async () => {
    spawnMock.mockResolvedValue("sid-2");
    const t = createTask({ title: "x", body: "x", dispatch: "manual" });
    await updateTask(t.id, { section: "DOING" });

    expect(await dispatchTodoTask(t.id)).toEqual({ action: "spawned", sessionId: "sid-2" });
  });

  it("skips when a run is already live", async () => {
    const t = createTask({ title: "x", body: "x", dispatch: "manual" });
    await appendRun(join(TMP_SESSIONS, t.id), {
      sessionId: "11111111-1111-1111-1111-111111111111",
      role: "coordinator", repo: "claude-bridge", status: "running",
      startedAt: EARLIER, endedAt: null,
    });

    expect(await dispatchTodoTask(t.id)).toEqual({ action: "skipped", reason: "run already live" });
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("skips BLOCKED, DONE and unknown tasks", async () => {
    const t = createTask({ title: "x", body: "x", dispatch: "manual" });
    await updateTask(t.id, { section: "BLOCKED" });
    expect((await dispatchTodoTask(t.id)).action).toBe("skipped");
    await updateTask(t.id, { section: "DONE — not yet archived", checked: true });
    expect((await dispatchTodoTask(t.id)).action).toBe("skipped");
    expect((await dispatchTodoTask("t_20260101_999")).action).toBe("skipped");
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("spawns a fresh coordinator even when an earlier one was killed", async () => {
    spawnMock.mockResolvedValue("sid-3");
    const t = createTask({ title: "x", body: "x" });
    await appendRun(join(TMP_SESSIONS, t.id), {
      sessionId: "22222222-2222-2222-2222-222222222222",
      role: "coordinator", repo: "claude-bridge", status: "cancelled",
      startedAt: EARLIER, endedAt: EARLIER,
    });

    expect(await dispatchTodoTask(t.id)).toEqual({ action: "spawned", sessionId: "sid-3" });
  });

  it("only one of two concurrent calls spawns", async () => {
    let release: ((v: string) => void) | null = null;
    spawnMock.mockImplementation(() => new Promise<string>((res) => { release = res; }));
    const t = createTask({ title: "x", body: "x", dispatch: "manual" });

    const a = dispatchTodoTask(t.id);
    const b = await dispatchTodoTask(t.id);
    // `a` is still inside the gate (awaiting the spawn); let it reach the
    // spawn call before releasing so the test can't outrun it.
    for (let i = 0; i < 200 && !release; i++) await new Promise((r) => setTimeout(r, 5));
    expect(release).not.toBeNull();
    release!("sid-4");
    expect(await a).toEqual({ action: "spawned", sessionId: "sid-4" });
    expect(b).toEqual({ action: "skipped", reason: "dispatch already in flight" });
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it("opens the plan gate at dispatch time when the operator gate is on", async () => {
    spawnMock.mockResolvedValue("sid-6");
    gateState.operatorEnabled = true;
    const t = createTask({ title: "x", body: "x", dispatch: "manual" });
    expect(readMeta(join(TMP_SESSIONS, t.id))?.intake ?? null).toBeNull();

    await dispatchTodoTask(t.id);

    const intake = readMeta(join(TMP_SESSIONS, t.id))?.intake;
    expect(intake?.status).toBe("planning");
    expect(intake?.submittedBy).toEqual({ kind: "operator", label: "operator" });
  });

  it("leaves intake alone when the operator gate is off", async () => {
    spawnMock.mockResolvedValue("sid-7");
    gateState.operatorEnabled = false;
    const t = createTask({ title: "x", body: "x", dispatch: "manual" });
    await dispatchTodoTask(t.id);
    expect(readMeta(join(TMP_SESSIONS, t.id))?.intake ?? null).toBeNull();
    gateState.operatorEnabled = true;
  });

  it("reports a failed spawn without clearing the schedule", async () => {
    spawnMock.mockResolvedValue(null);
    const t = createTask({ title: "x", body: "x", dispatch: "manual", scheduledAt: LATER });
    expect(await dispatchTodoTask(t.id)).toEqual({ action: "failed", reason: "coordinator spawn returned null" });
    expect(getTask(t.id)?.scheduledAt).toBe(LATER);
  });
});

describe("scheduled start", () => {
  beforeEach(() => { spawnMock.mockReset(); wipe(); });
  afterEach(wipe);

  it("dueScheduledTasks picks TODO tasks whose time has come and nothing else", () => {
    const due = createTask({ title: "due", body: "due", dispatch: "manual", scheduledAt: EARLIER });
    createTask({ title: "later", body: "later", dispatch: "manual", scheduledAt: LATER });
    createTask({ title: "noschedule", body: "noschedule", dispatch: "manual" });
    const ids = dueScheduledTasks(listTasks(), NOW).map((t) => t.id);
    expect(ids).toEqual([due.id]);
  });

  it("ignores due tasks that already left TODO or were ticked done", async () => {
    const moved = createTask({ title: "moved", body: "moved", dispatch: "manual", scheduledAt: EARLIER });
    await updateTask(moved.id, { section: "DOING" });
    const done = createTask({ title: "done", body: "done", dispatch: "manual", scheduledAt: EARLIER });
    await updateTask(done.id, { section: "DONE — not yet archived", checked: true });
    expect(dueScheduledTasks(listTasks(), NOW)).toEqual([]);
  });

  it("scheduledStartTick dispatches every due task", async () => {
    spawnMock.mockResolvedValue("sid-5");
    const a = createTask({ title: "a", body: "a", dispatch: "manual", scheduledAt: EARLIER });
    const b = createTask({ title: "b", body: "b", dispatch: "manual", scheduledAt: EARLIER });
    createTask({ title: "c", body: "c", dispatch: "manual", scheduledAt: LATER });

    await scheduledStartTick(NOW);

    const spawned = spawnMock.mock.calls.map((c) => c[0].id).sort();
    expect(spawned).toEqual([a.id, b.id].sort());
    expect(getTask(a.id)?.scheduledAt).toBeNull();
  });
});
