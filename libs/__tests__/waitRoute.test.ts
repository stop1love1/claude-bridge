import { afterEach, describe, expect, it, vi } from "vitest";
import { rmSync } from "node:fs";
import { join } from "node:path";

const TMP_SESSIONS = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { mkdtempSync } = require("node:fs") as typeof import("node:fs");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { tmpdir } = require("node:os") as typeof import("node:os");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { join } = require("node:path") as typeof import("node:path");
  return mkdtempSync(join(tmpdir(), "bridge-wait-"));
});

vi.mock("../paths", async () => {
  const actual = await vi.importActual<typeof import("../paths")>("../paths");
  return { ...actual, SESSIONS_DIR: TMP_SESSIONS };
});

const TASK_ID = "t_20260905_101";
const COORD_SID = "0de0dccc-c2c6-45e4-b87d-8965900f9a6d";
const CHILD_A_SID = "aaaaaaaa-1111-4222-8333-444444444444";
const CHILD_B_SID = "bbbbbbbb-1111-4222-8333-444444444444";
const OTHER_PARENT_SID = "cccccccc-1111-4222-8333-444444444444";

const HEADER = {
  taskId: TASK_ID,
  taskTitle: "wait route test",
  taskBody: "",
  taskStatus: "doing" as const,
  taskSection: "DOING" as const,
  taskChecked: false,
  createdAt: "2026-09-05T10:00:00Z",
};

function taskDir() {
  return join(TMP_SESSIONS, TASK_ID);
}

function child(
  sessionId: string,
  status: "running" | "done" | "failed",
  parentSessionId: string = COORD_SID,
) {
  return {
    sessionId,
    role: "coder",
    repo: "claude-bridge",
    status,
    startedAt: "2026-09-05T10:01:00Z",
    endedAt: status === "running" ? null : "2026-09-05T10:05:00Z",
    parentSessionId,
  };
}

async function postWait(body: unknown, signal?: AbortSignal) {
  const { NextRequest } = await import("next/server");
  const { POST } = await import("@/app/api/tasks/[id]/wait/route");
  const req = new NextRequest(`http://localhost:7777/api/tasks/${TASK_ID}/wait`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
    ...(signal ? { signal } : {}),
  });
  return POST(req, { params: Promise.resolve({ id: TASK_ID }) });
}

async function seed(...runs: ReturnType<typeof child>[]) {
  const { createMeta, appendRun } = await import("../meta");
  createMeta(taskDir(), HEADER);
  for (const r of runs) await appendRun(taskDir(), r);
}

describe("POST /api/tasks/[id]/wait — coordinator long-poll", () => {
  afterEach(() => {
    try { rmSync(taskDir(), { recursive: true, force: true }); } catch { }
  });

  it("returns immediately with timedOut:false when every child is already terminal", async () => {
    await seed(child(CHILD_A_SID, "done"), child(CHILD_B_SID, "failed"));

    const started = Date.now();
    const res = await postWait({ parentSessionId: COORD_SID, timeoutMs: 5000 });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.timedOut).toBe(false);
    expect(body.pending).toEqual([]);
    expect(body.settled.map((r: { sessionId: string }) => r.sessionId).sort()).toEqual(
      [CHILD_A_SID, CHILD_B_SID].sort(),
    );
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it("resolves as soon as updateRun flips a pending child to a terminal status", async () => {
    await seed(child(CHILD_A_SID, "running"), child(CHILD_B_SID, "running"));
    const { updateRun } = await import("../meta");

    const pending = postWait({ parentSessionId: COORD_SID, timeoutMs: 5000 });
    await new Promise((r) => setTimeout(r, 50));
    await updateRun(taskDir(), CHILD_A_SID, { status: "done", endedAt: "2026-09-05T10:06:00Z" });

    const res = await pending;
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.timedOut).toBe(false);
    expect(body.settled.map((r: { sessionId: string }) => r.sessionId)).toEqual([CHILD_A_SID]);
    expect(body.pending.map((r: { sessionId: string }) => r.sessionId)).toEqual([CHILD_B_SID]);
  });

  it("returns timedOut:true with the still-running children after timeoutMs", async () => {
    await seed(child(CHILD_A_SID, "running"), child(CHILD_B_SID, "done"));

    const res = await postWait({ parentSessionId: COORD_SID, timeoutMs: 100 });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.timedOut).toBe(true);
    expect(body.pending.map((r: { sessionId: string }) => r.sessionId)).toEqual([CHILD_A_SID]);
    expect(body.settled.map((r: { sessionId: string }) => r.sessionId)).toEqual([CHILD_B_SID]);
  });

  it("filters by sessionIds and ignores children of other parents", async () => {
    await seed(
      child(CHILD_A_SID, "running"),
      child(CHILD_B_SID, "done"),
      child(OTHER_PARENT_SID, "running", OTHER_PARENT_SID),
    );

    const res = await postWait({
      parentSessionId: COORD_SID,
      sessionIds: [CHILD_B_SID],
      timeoutMs: 5000,
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.timedOut).toBe(false);
    expect(body.pending).toEqual([]);
    expect(body.settled.map((r: { sessionId: string }) => r.sessionId)).toEqual([CHILD_B_SID]);
  });

  it("stops waiting when the request is aborted", async () => {
    await seed(child(CHILD_A_SID, "running"));
    const ac = new AbortController();

    const pending = postWait({ parentSessionId: COORD_SID, timeoutMs: 5000 }, ac.signal);
    await new Promise((r) => setTimeout(r, 20));
    const started = Date.now();
    ac.abort();

    const res = await pending;
    expect(Date.now() - started).toBeLessThan(1000);
    const body = await res.json();
    expect(body.timedOut).toBe(false);
    expect(body.pending.map((r: { sessionId: string }) => r.sessionId)).toEqual([CHILD_A_SID]);
  });

  it("400s when parentSessionId is missing or not a UUID", async () => {
    await seed(child(CHILD_A_SID, "done"));

    const missing = await postWait({ timeoutMs: 100 });
    expect(missing.status).toBe(400);
    expect((await missing.json()).error).toMatch(/parentSessionId/);

    const invalid = await postWait({ parentSessionId: "not-a-uuid" });
    expect(invalid.status).toBe(400);

    const badIds = await postWait({ parentSessionId: COORD_SID, sessionIds: ["nope"] });
    expect(badIds.status).toBe(400);

    const badTimeout = await postWait({ parentSessionId: COORD_SID, timeoutMs: "soon" });
    expect(badTimeout.status).toBe(400);
  });

  it("404s when the task has no meta.json", async () => {
    const res = await postWait({ parentSessionId: COORD_SID });
    expect(res.status).toBe(404);
  });
});
