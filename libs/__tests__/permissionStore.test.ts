import { afterEach, beforeEach, describe, expect, it } from "vitest";

beforeEach(() => {
  delete (globalThis as { __bridgePermissionStore?: unknown }).__bridgePermissionStore;
});

afterEach(() => {
  delete (globalThis as { __bridgePermissionStore?: unknown }).__bridgePermissionStore;
});

const baseReq = {
  sessionId: "sess-1",
  requestId: "req-a",
  tool: "Bash",
  input: { cmd: "ls" },
  createdAt: "2026-01-01T00:00:00Z",
};

describe("announcePending / getPending / listPending", () => {
  it("announces a request and surfaces it via lookup + list", async () => {
    const store = await import("../permissionStore");
    store.announcePending(baseReq);
    const got = store.getPending("sess-1", "req-a");
    expect(got).toBeDefined();
    expect(got?.status).toBe("pending");
    expect(store.listPending("sess-1")).toHaveLength(1);
  });

  it("listPending isolates by sessionId", async () => {
    const store = await import("../permissionStore");
    store.announcePending(baseReq);
    store.announcePending({ ...baseReq, sessionId: "sess-2", requestId: "req-z" });
    expect(store.listPending("sess-1")).toHaveLength(1);
    expect(store.listPending("sess-2")).toHaveLength(1);
    expect(store.listAllPending()).toHaveLength(2);
  });

  it("listPending omits answered entries", async () => {
    const store = await import("../permissionStore");
    store.announcePending(baseReq);
    store.answer("sess-1", "req-a", "allow");
    expect(store.listPending("sess-1")).toHaveLength(0);
  });
});

describe("answer", () => {
  it("flips status and stores reason", async () => {
    const store = await import("../permissionStore");
    store.announcePending(baseReq);
    const out = store.answer("sess-1", "req-a", "deny", "operator clicked deny");
    expect(out?.status).toBe("deny");
    expect(out?.reason).toBe("operator clicked deny");
  });

  it("returns null for unknown session/request", async () => {
    const store = await import("../permissionStore");
    expect(store.answer("nope", "x", "allow")).toBeNull();
  });
});

describe("consume", () => {
  it("removes the entry so subsequent getPending returns undefined", async () => {
    const store = await import("../permissionStore");
    store.announcePending(baseReq);
    store.consume("sess-1", "req-a");
    expect(store.getPending("sess-1", "req-a")).toBeUndefined();
  });
});

describe("subscribe — per-session emitter", () => {
  it("notifies on new pending and on answer", async () => {
    const store = await import("../permissionStore");
    const pendings: string[] = [];
    const answereds: string[] = [];
    const off = store.subscribe(
      "sess-1",
      (r) => pendings.push(r.requestId),
      (r) => answereds.push(r.requestId),
    );
    store.announcePending(baseReq);
    store.answer("sess-1", "req-a", "allow");
    expect(pendings).toEqual(["req-a"]);
    expect(answereds).toEqual(["req-a"]);
    off();
    store.announcePending({ ...baseReq, requestId: "req-b" });
    expect(pendings).toEqual(["req-a"]);
  });

  it("does NOT notify subscribers of other sessions", async () => {
    const store = await import("../permissionStore");
    const seen: string[] = [];
    const off = store.subscribe("sess-1", (r) => seen.push(r.requestId));
    store.announcePending({ ...baseReq, sessionId: "sess-2", requestId: "x" });
    expect(seen).toEqual([]);
    off();
  });
});

describe("subscribeAll — global emitter", () => {
  it("notifies for every session", async () => {
    const store = await import("../permissionStore");
    const seen: string[] = [];
    const off = store.subscribeAll((r) => seen.push(`${r.sessionId}:${r.requestId}`));
    store.announcePending(baseReq);
    store.announcePending({ ...baseReq, sessionId: "sess-2", requestId: "req-z" });
    expect(seen).toEqual(["sess-1:req-a", "sess-2:req-z"]);
    off();
    store.announcePending({ ...baseReq, requestId: "req-c" });
    expect(seen).toEqual(["sess-1:req-a", "sess-2:req-z"]);
  });

  it("subscribeAllPermissions catches and swallows callback errors", async () => {
    const store = await import("../permissionStore");
    const off = store.subscribeAllPermissions(() => {
      throw new Error("subscriber blew up");
    });
    expect(() => store.announcePending(baseReq)).not.toThrow();
    off();
  });
});

describe("permission/stream route — emitter actually released on teardown", () => {
  it("drops the per-session emitter's listeners when the stream is cancelled without req.signal firing, and consume() then evicts it", async () => {
    const streamSessionId = "11111111-1111-1111-1111-111111111111";
    const store = await import("../permissionStore");
    const { NextRequest } = await import("next/server");
    const { GET } = await import("../../app/api/sessions/[sessionId]/permission/stream/route");

    const req = new NextRequest(`http://localhost/api/sessions/${streamSessionId}/permission/stream`);
    const res = await GET(req, { params: Promise.resolve({ sessionId: streamSessionId }) });

    const during = store._emitterDebugInfo(streamSessionId);
    expect(during.exists).toBe(true);
    expect(during.pending).toBeGreaterThan(0);
    expect(during.answered).toBeGreaterThan(0);

    await res.body!.cancel();

    const after = store._emitterDebugInfo(streamSessionId);
    expect(after.pending).toBe(0);
    expect(after.answered).toBe(0);

    store.announcePending({
      sessionId: streamSessionId,
      requestId: "req-evict",
      tool: "Bash",
      input: {},
      createdAt: "2026-01-01T00:00:00Z",
    });
    store.consume(streamSessionId, "req-evict");
    expect(store._emitterDebugInfo(streamSessionId).exists).toBe(false);
  });

  it("drops the per-session emitter's listeners when req.signal aborts, and consume() then evicts it", async () => {
    const streamSessionId = "22222222-2222-2222-2222-222222222222";
    const store = await import("../permissionStore");
    const { NextRequest } = await import("next/server");
    const { GET } = await import("../../app/api/sessions/[sessionId]/permission/stream/route");

    const ac = new AbortController();
    const req = new NextRequest(`http://localhost/api/sessions/${streamSessionId}/permission/stream`, {
      signal: ac.signal,
    });
    await GET(req, { params: Promise.resolve({ sessionId: streamSessionId }) });

    const during = store._emitterDebugInfo(streamSessionId);
    expect(during.exists).toBe(true);
    expect(during.pending).toBeGreaterThan(0);

    ac.abort();
    await Promise.resolve();

    const after = store._emitterDebugInfo(streamSessionId);
    expect(after.pending).toBe(0);
    expect(after.answered).toBe(0);

    store.announcePending({
      sessionId: streamSessionId,
      requestId: "req-evict",
      tool: "Bash",
      input: {},
      createdAt: "2026-01-01T00:00:00Z",
    });
    store.consume(streamSessionId, "req-evict");
    expect(store._emitterDebugInfo(streamSessionId).exists).toBe(false);
  });
});

describe("permission/stream route (global) — emitter actually released on teardown", () => {
  it("drops the global emitter's listeners when the stream is cancelled without req.signal firing", async () => {
    const store = await import("../permissionStore");
    const { NextRequest } = await import("next/server");
    const { GET } = await import("../../app/api/permission/stream/route");

    const before = store._globalEmitterDebugInfo();

    const req = new NextRequest("http://localhost/api/permission/stream");
    const res = await GET(req);

    const during = store._globalEmitterDebugInfo();
    expect(during.pending).toBe(before.pending + 1);
    expect(during.answered).toBe(before.answered + 1);

    await res.body!.cancel();

    const after = store._globalEmitterDebugInfo();
    expect(after.pending).toBe(before.pending);
    expect(after.answered).toBe(before.answered);
  });

  it("drops the global emitter's listeners when req.signal aborts", async () => {
    const store = await import("../permissionStore");
    const { NextRequest } = await import("next/server");
    const { GET } = await import("../../app/api/permission/stream/route");

    const before = store._globalEmitterDebugInfo();

    const ac = new AbortController();
    const req = new NextRequest("http://localhost/api/permission/stream", { signal: ac.signal });
    await GET(req);

    const during = store._globalEmitterDebugInfo();
    expect(during.pending).toBe(before.pending + 1);
    expect(during.answered).toBe(before.answered + 1);

    ac.abort();
    await Promise.resolve();

    const after = store._globalEmitterDebugInfo();
    expect(after.pending).toBe(before.pending);
    expect(after.answered).toBe(before.answered);
  });
});
