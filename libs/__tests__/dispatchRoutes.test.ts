import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { rmSync, readdirSync } from "node:fs";
import { join } from "node:path";

const TMP_SESSIONS = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { mkdtempSync } = require("node:fs") as typeof import("node:fs");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { tmpdir } = require("node:os") as typeof import("node:os");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { join } = require("node:path") as typeof import("node:path");
  return mkdtempSync(join(tmpdir(), "bridge-dispatch-routes-"));
});

vi.mock("../paths", async () => {
  const actual = await vi.importActual<typeof import("../paths")>("../paths");
  return { ...actual, SESSIONS_DIR: TMP_SESSIONS };
});

const spawnMock = vi.hoisted(() => vi.fn<(task: { id: string }) => Promise<string | null>>());
vi.mock("../coordinator", () => ({
  spawnCoordinatorForTask: (task: { id: string }) => spawnMock(task),
}));

import { createTask, getTask, updateTask } from "../tasksStore";
import { parseScheduledAt } from "../validate";

const LATER = "2026-09-05T20:00:00.000Z";

function wipe() {
  for (const id of readdirSync(TMP_SESSIONS)) {
    try { rmSync(join(TMP_SESSIONS, id), { recursive: true, force: true }); } catch { }
  }
}

describe("parseScheduledAt", () => {
  it("accepts null/undefined as 'no schedule'", () => {
    expect(parseScheduledAt(null)).toEqual({ ok: true, value: null });
    expect(parseScheduledAt(undefined)).toEqual({ ok: true, value: null });
    expect(parseScheduledAt("")).toEqual({ ok: true, value: null });
  });
  it("normalises a parseable date to ISO", () => {
    expect(parseScheduledAt("2026-09-05T20:00")).toEqual({
      ok: true,
      value: new Date("2026-09-05T20:00").toISOString(),
    });
    expect(parseScheduledAt(LATER)).toEqual({ ok: true, value: LATER });
  });
  it("rejects garbage", () => {
    expect(parseScheduledAt("tomorrow-ish").ok).toBe(false);
    expect(parseScheduledAt(42).ok).toBe(false);
  });
});

describe("PATCH /api/tasks/[id] — scheduledAt", () => {
  beforeEach(wipe);
  afterEach(wipe);

  async function patch(id: string, body: unknown) {
    const { PATCH } = await import("@/app/api/tasks/[id]/route");
    const req = new Request(`http://localhost:7777/api/tasks/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return PATCH(req as any, { params: Promise.resolve({ id }) });
  }

  it("sets a schedule on a TODO task", async () => {
    const t = createTask({ title: "x", body: "x", dispatch: "manual" });
    const res = await patch(t.id, { scheduledAt: LATER });
    expect(res.status).toBe(200);
    expect(getTask(t.id)?.scheduledAt).toBe(LATER);
  });

  it("clears a schedule with null", async () => {
    const t = createTask({ title: "x", body: "x", dispatch: "manual", scheduledAt: LATER });
    const res = await patch(t.id, { scheduledAt: null });
    expect(res.status).toBe(200);
    expect(getTask(t.id)?.scheduledAt).toBeNull();
  });

  it("refuses to schedule a task that is not waiting in TODO", async () => {
    const t = createTask({ title: "x", body: "x", dispatch: "manual" });
    await updateTask(t.id, { section: "DOING" });
    const res = await patch(t.id, { scheduledAt: LATER });
    expect(res.status).toBe(409);
    expect(getTask(t.id)?.scheduledAt).toBeNull();
  });

  it("rejects an unparseable time", async () => {
    const t = createTask({ title: "x", body: "x", dispatch: "manual" });
    const res = await patch(t.id, { scheduledAt: "soon" });
    expect(res.status).toBe(400);
  });
});

describe("POST /api/tasks/[id]/dispatch", () => {
  beforeEach(() => { spawnMock.mockReset(); wipe(); });
  afterEach(wipe);

  async function dispatch(id: string) {
    const { POST } = await import("@/app/api/tasks/[id]/dispatch/route");
    const req = new Request(`http://localhost:7777/api/tasks/${id}/dispatch`, { method: "POST" });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return POST(req as any, { params: Promise.resolve({ id }) });
  }

  it("starts a waiting task", async () => {
    spawnMock.mockResolvedValue("sid-9");
    const t = createTask({ title: "x", body: "x", dispatch: "manual", scheduledAt: LATER });
    const res = await dispatch(t.id);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ action: "spawned", sessionId: "sid-9" });
    expect(getTask(t.id)?.scheduledAt).toBeNull();
  });

  it("answers 409 when there is nothing to start", async () => {
    const t = createTask({ title: "x", body: "x", dispatch: "manual" });
    await updateTask(t.id, { section: "BLOCKED" });
    const res = await dispatch(t.id);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ action: "skipped" });
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("answers 500 when the spawn fails", async () => {
    spawnMock.mockResolvedValue(null);
    const t = createTask({ title: "x", body: "x", dispatch: "manual" });
    const res = await dispatch(t.id);
    expect(res.status).toBe(500);
  });

  it("rejects a malformed id", async () => {
    const res = await dispatch("nope");
    expect(res.status).toBe(400);
  });
});
