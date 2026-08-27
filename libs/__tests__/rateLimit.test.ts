import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";

vi.mock("node:child_process", () => ({
  spawn: vi.fn(() => {
    const proc = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter & { setEncoding: (enc: string) => void };
      stderr: EventEmitter & { setEncoding: (enc: string) => void };
      kill: (signal?: string) => void;
    };
    proc.stdout = Object.assign(new EventEmitter(), { setEncoding: () => {} });
    proc.stderr = Object.assign(new EventEmitter(), { setEncoding: () => {} });
    proc.kill = () => {};
    setImmediate(() => proc.emit("exit", 0, null));
    return proc;
  }),
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, existsSync: () => true };
});

vi.mock("@/libs/apps", () => ({
  resolveAppFromRouteSegment: () => ({ name: "demo", path: "C:\\fake-app" }),
}));


beforeEach(() => {
  // global singleton stash. Cheaper than a full module reset.
  delete (globalThis as { __bridgeRateLimit?: unknown }).__bridgeRateLimit;
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("rateLimit fixed-window behavior", () => {
  it("returns ok=true until the limit is reached, then ok=false", async () => {
    const { rateLimit } = await import("../rateLimit");
    const limit = 3;
    const window = 1000;
    expect(rateLimit("t", "ip", limit, window).ok).toBe(true);
    expect(rateLimit("t", "ip", limit, window).ok).toBe(true);
    expect(rateLimit("t", "ip", limit, window).ok).toBe(true);
    const overLimit = rateLimit("t", "ip", limit, window);
    expect(overLimit.ok).toBe(false);
    expect(overLimit.hits).toBe(4);
    expect(overLimit.limit).toBe(3);
    expect(overLimit.retryAfterMs).toBeGreaterThan(0);
    expect(overLimit.retryAfterMs).toBeLessThanOrEqual(window);
  });

  it("resets when the window elapses", async () => {
    const { rateLimit } = await import("../rateLimit");
    const limit = 2;
    const window = 1000;
    rateLimit("t", "ip", limit, window);
    rateLimit("t", "ip", limit, window);
    expect(rateLimit("t", "ip", limit, window).ok).toBe(false);
    vi.advanceTimersByTime(window + 1);
    expect(rateLimit("t", "ip", limit, window).ok).toBe(true);
  });

  it("isolates buckets and keys", async () => {
    const { rateLimit } = await import("../rateLimit");
    rateLimit("a", "k", 1, 1000);
    expect(rateLimit("a", "k", 1, 1000).ok).toBe(false);
    expect(rateLimit("a", "other", 1, 1000).ok).toBe(true);
    expect(rateLimit("b", "k", 1, 1000).ok).toBe(true);
  });
});

describe("rateLimitClear", () => {
  it("resets a bucket so the next call is ok again", async () => {
    const { rateLimit, rateLimitClear } = await import("../rateLimit");
    rateLimit("t", "ip", 1, 1000);
    expect(rateLimit("t", "ip", 1, 1000).ok).toBe(false);
    rateLimitClear("t", "ip");
    expect(rateLimit("t", "ip", 1, 1000).ok).toBe(true);
  });

  it("only clears the matching (bucket, key) pair", async () => {
    const { rateLimit, rateLimitClear } = await import("../rateLimit");
    rateLimit("a", "k1", 1, 1000);
    rateLimit("a", "k2", 1, 1000);
    rateLimitClear("a", "k1");
    expect(rateLimit("a", "k1", 1, 1000).ok).toBe(true);
    expect(rateLimit("a", "k2", 1, 1000).ok).toBe(false);
  });
});

describe("checkRateLimit", () => {
  it("returns null when within budget", async () => {
    const { checkRateLimit } = await import("../rateLimit");
    expect(checkRateLimit("t", "ip", 5, 1000)).toBeNull();
  });

  it("returns a 429 denial shape when over budget", async () => {
    const { checkRateLimit } = await import("../rateLimit");
    checkRateLimit("t", "ip", 1, 1000);
    const denial = checkRateLimit("t", "ip", 1, 1000);
    expect(denial).not.toBeNull();
    expect(denial?.status).toBe(429);
    expect(denial?.body.error).toBe("too many requests");
    expect(denial?.body.hint).toBeTruthy();
    expect(denial?.headers["Retry-After"]).toMatch(/^\d+$/);
  });

  it("Retry-After is at least 1 second even when window has milliseconds left", async () => {
    const { checkRateLimit } = await import("../rateLimit");
    checkRateLimit("t", "ip", 1, 50);
    const denial = checkRateLimit("t", "ip", 1, 50);
    expect(denial).not.toBeNull();
    expect(Number(denial?.headers["Retry-After"])).toBeGreaterThanOrEqual(1);
  });
});

describe("apps/[name]/exec route rate limiting", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  async function callExec() {
    const { NextRequest } = await import("next/server");
    const { POST } = await import("../../app/api/apps/[name]/exec/route");
    const req = new NextRequest("http://localhost/api/apps/demo/exec", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ command: "echo hi" }),
    });
    return POST(req, { params: Promise.resolve({ name: "demo" }) });
  }

  it("allows 6 requests per minute from the same IP then denies the 7th with 429", async () => {
    for (let i = 0; i < 6; i++) {
      const res = await callExec();
      expect(res.status).not.toBe(429);
    }
    const denied = await callExec();
    expect(denied.status).toBe(429);
    const body = await denied.json();
    expect(body.error).toBe("too many requests");
  });
});
