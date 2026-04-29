import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * loginApprovals stores its in-memory map on `globalThis`. We clear it
 * between tests so a leak from one doesn't influence the next.
 */
beforeEach(() => {
  delete (globalThis as { __bridgeLoginApprovals?: unknown }).__bridgeLoginApprovals;
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

const sampleArgs = {
  email: "op@example.com",
  trust: true,
  deviceLabel: "Chrome on Windows",
  remoteIp: "127.0.0.1",
  userAgent: "Mozilla/5.0",
};

describe("createPendingLogin", () => {
  it("returns a record with a unique id, status=pending, and a 3-min expiry", async () => {
    const { createPendingLogin, APPROVAL_TTL_MS } = await import("../loginApprovals");
    const t = Date.UTC(2026, 0, 1);
    vi.setSystemTime(t);
    const a = createPendingLogin(sampleArgs);
    const b = createPendingLogin(sampleArgs);
    expect(a.id).not.toBe(b.id);
    expect(a.status).toBe("pending");
    expect(a.expiresAt - t).toBe(APPROVAL_TTL_MS);
    expect(a.email).toBe(sampleArgs.email);
    expect(a.deviceLabel).toBe(sampleArgs.deviceLabel);
  });
});

describe("getPendingLogin / answerPendingLogin / consumePendingLogin", () => {
  it("retrieves a pending entry by id", async () => {
    const { createPendingLogin, getPendingLogin } = await import("../loginApprovals");
    const a = createPendingLogin(sampleArgs);
    expect(getPendingLogin(a.id)?.id).toBe(a.id);
    expect(getPendingLogin("nope")).toBeNull();
  });

  it("transitions pending → approved exactly once", async () => {
    const { createPendingLogin, answerPendingLogin } = await import("../loginApprovals");
    const a = createPendingLogin(sampleArgs);
    const ok = answerPendingLogin(a.id, "approved");
    expect(ok?.status).toBe("approved");
    // Re-answering does not flip back; returns the existing record.
    const reAnswer = answerPendingLogin(a.id, "denied");
    expect(reAnswer?.status).toBe("approved");
  });

  it("attaches a reason on deny and caps the length", async () => {
    const { createPendingLogin, answerPendingLogin } = await import("../loginApprovals");
    const a = createPendingLogin(sampleArgs);
    const big = "x".repeat(500);
    const denied = answerPendingLogin(a.id, "denied", big);
    expect(denied?.status).toBe("denied");
    expect(denied?.reason?.length).toBe(200);
  });

  it("returns null when answering an unknown id", async () => {
    const { answerPendingLogin } = await import("../loginApprovals");
    expect(answerPendingLogin("does-not-exist", "approved")).toBeNull();
  });

  it("consume removes the entry so a later get returns null", async () => {
    const { createPendingLogin, getPendingLogin, consumePendingLogin } =
      await import("../loginApprovals");
    const a = createPendingLogin(sampleArgs);
    consumePendingLogin(a.id);
    expect(getPendingLogin(a.id)).toBeNull();
  });
});

describe("expiry pruning", () => {
  it("getPendingLogin drops a pending entry past its expiresAt", async () => {
    const { createPendingLogin, getPendingLogin, APPROVAL_TTL_MS } =
      await import("../loginApprovals");
    const a = createPendingLogin(sampleArgs);
    vi.advanceTimersByTime(APPROVAL_TTL_MS + 1000);
    expect(getPendingLogin(a.id)).toBeNull();
  });

  it("listPendingLogins only returns status=pending", async () => {
    const { createPendingLogin, answerPendingLogin, listPendingLogins } =
      await import("../loginApprovals");
    const a = createPendingLogin(sampleArgs);
    const b = createPendingLogin(sampleArgs);
    answerPendingLogin(b.id, "denied");
    const live = listPendingLogins();
    expect(live.map((e) => e.id)).toEqual([a.id]);
  });

  it("answered entries are kept briefly so the requesting device can see the verdict", async () => {
    const { createPendingLogin, answerPendingLogin, getPendingLogin } =
      await import("../loginApprovals");
    const a = createPendingLogin(sampleArgs);
    answerPendingLogin(a.id, "approved");
    // Bump 1 minute — well within the 5-minute post-answer keep window.
    vi.advanceTimersByTime(60 * 1000);
    expect(getPendingLogin(a.id)?.status).toBe("approved");
  });
});
