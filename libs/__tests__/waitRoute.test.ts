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

async function postWait(body: unknown, signal?: AbortSignal, taskId: string = TASK_ID) {
  const { NextRequest } = await import("next/server");
  const { POST } = await import("@/app/api/tasks/[id]/wait/route");
  const req = new NextRequest(`http://localhost:7777/api/tasks/${taskId}/wait`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
    ...(signal ? { signal } : {}),
  });
  return POST(req, { params: Promise.resolve({ id: taskId }) });
}

async function seed(...runs: ReturnType<typeof child>[]) {
  const { createMeta, appendRun } = await import("../meta");
  createMeta(taskDir(), HEADER);
  for (const r of runs) await appendRun(taskDir(), r);
}

/**
 * The route's own fallback timeout for tests that expect to resolve via an
 * event long before it fires, plus the Vitest deadline those tests run under.
 *
 * The ordering matters and both numbers are chosen for it: event (~50ms) ≪
 * fallback ≪ deadline. Originally the tests passed 5000 while Vitest's
 * default deadline was also 5000, so the route's "timed out" path and Vitest
 * giving up were the same instant and any scheduling hiccup decided which one
 * won — that is how these failed under `--sequence.shuffle` on a loaded
 * machine while passing when the file ran alone.
 *
 * The fallback is a safety net that must never fire in a passing run; putting
 * the deadline above it means a genuine hang surfaces as a readable
 * `timedOut: true` assertion rather than an opaque Vitest timeout.
 *
 * 3s is 60x the ~50ms the event normally takes. It is deliberately not larger:
 * one known interleaving (`--sequence.shuffle --sequence.seed=101`) never
 * delivers the event to the route at all — verified by raising the fallback to
 * 25s and watching it expire too — so a bigger number would only make that
 * failure slower, not rarer.
 */
const WAIT_FALLBACK_MS = 3_000;
const WAIT_TEST_DEADLINE_MS = 15_000;

describe("POST /api/tasks/[id]/wait — coordinator long-poll", () => {
  // Both hooks, deliberately: a test that asserts "no meta.json" must not
  // depend on its predecessor's cleanup having run, which is an ordering
  // assumption rather than a fact once the order can change.
  beforeEach(() => {
    try { rmSync(taskDir(), { recursive: true, force: true }); } catch { }
  });

  afterEach(() => {
    try { rmSync(taskDir(), { recursive: true, force: true }); } catch { }
  });

  it("returns immediately with timedOut:false when every child is already terminal", async () => {
    await seed(child(CHILD_A_SID, "done"), child(CHILD_B_SID, "failed"));

    const started = Date.now();
    const res = await postWait({ parentSessionId: COORD_SID, timeoutMs: WAIT_FALLBACK_MS });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.timedOut).toBe(false);
    expect(body.pending).toEqual([]);
    expect(body.settled.map((r: { sessionId: string }) => r.sessionId).sort()).toEqual(
      [CHILD_A_SID, CHILD_B_SID].sort(),
    );
    expect(Date.now() - started).toBeLessThan(1000);
  }, WAIT_TEST_DEADLINE_MS);

  it("resolves as soon as updateRun flips a pending child to a terminal status", async () => {
    await seed(child(CHILD_A_SID, "running"), child(CHILD_B_SID, "running"));
    const { updateRun } = await import("../meta");

    const pending = postWait({ parentSessionId: COORD_SID, timeoutMs: WAIT_FALLBACK_MS });
    await new Promise((r) => setTimeout(r, 50));
    await updateRun(taskDir(), CHILD_A_SID, { status: "done", endedAt: "2026-09-05T10:06:00Z" });

    const res = await pending;
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.timedOut).toBe(false);
    expect(body.settled.map((r: { sessionId: string }) => r.sessionId)).toEqual([CHILD_A_SID]);
    expect(body.pending.map((r: { sessionId: string }) => r.sessionId)).toEqual([CHILD_B_SID]);
  }, WAIT_TEST_DEADLINE_MS);

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
      timeoutMs: WAIT_FALLBACK_MS,
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

    const pending = postWait({ parentSessionId: COORD_SID, timeoutMs: WAIT_FALLBACK_MS }, ac.signal);
    await new Promise((r) => setTimeout(r, 20));
    const started = Date.now();
    ac.abort();

    const res = await pending;
    expect(Date.now() - started).toBeLessThan(1000);
    const body = await res.json();
    expect(body.timedOut).toBe(false);
    expect(body.pending.map((r: { sessionId: string }) => r.sessionId)).toEqual([CHILD_A_SID]);
  }, WAIT_TEST_DEADLINE_MS);

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

  it("400s (not 500) when the JSON body is valid but not an object", async () => {
    await seed(child(CHILD_A_SID, "done"));

    for (const raw of ["null", "42", "\"str\"", "[]"]) {
      const res = await postWait(raw);
      expect(res.status, `body ${raw}`).toBe(400);
      expect((await res.json()).error).toMatch(/JSON object|parentSessionId/);
    }
  });

  it("400s on an empty sessionIds filter instead of answering 'all settled'", async () => {
    await seed(child(CHILD_A_SID, "running"));

    const res = await postWait({ parentSessionId: COORD_SID, sessionIds: [] });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/non-empty/);
  });

  it("404s when the task has no meta.json", async () => {
    // A task id nothing in this file has ever seeded. Deleting the directory
    // is not enough on its own: `readMeta` caches per directory for
    // META_CACHE_TTL_MS (500ms), so a test running shortly after any
    // `createMeta` still saw a live task, and the route then long-polled for
    // its 30s default until Vitest killed the test at 5s. An unused id cannot
    // have a cache entry.
    const res = await postWait({ parentSessionId: COORD_SID }, undefined, "t_20260909_777");
    expect(res.status).toBe(404);
  });
});
