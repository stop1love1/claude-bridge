import { describe, expect, it, vi } from "vitest";

describe("createSseResponse — teardown idempotence", () => {
  it("runs teardown exactly once when the stream is cancelled", async () => {
    const { createSseResponse } = await import("../sse");
    const teardown = vi.fn();
    const res = createSseResponse({ onStart: () => teardown, keepaliveMs: 50 });
    await res.body!.cancel();
    expect(teardown).toHaveBeenCalledTimes(1);
  });

  it("runs teardown exactly once when the request aborts", async () => {
    const { createSseResponse } = await import("../sse");
    const ac = new AbortController();
    const teardown = vi.fn();
    createSseResponse({ signal: ac.signal, onStart: () => teardown, keepaliveMs: 50 });
    ac.abort();
    await Promise.resolve();
    expect(teardown).toHaveBeenCalledTimes(1);
  });

  it("does not run teardown twice when both fire", async () => {
    const { createSseResponse } = await import("../sse");
    const ac = new AbortController();
    const teardown = vi.fn();
    const res = createSseResponse({ signal: ac.signal, onStart: () => teardown, keepaliveMs: 50 });
    ac.abort();
    await res.body!.cancel();
    expect(teardown).toHaveBeenCalledTimes(1);
  });
});

describe("createSseResponse — wire format and lifecycle", () => {
  it("sets the standard SSE headers", async () => {
    const { createSseResponse } = await import("../sse");
    const res = createSseResponse({ onStart: () => () => {}, keepaliveMs: 50 });
    expect(res.headers.get("content-type")).toBe("text/event-stream; charset=utf-8");
    expect(res.headers.get("cache-control")).toBe("no-cache, no-transform");
    expect(res.headers.get("connection")).toBe("keep-alive");
    expect(res.headers.get("x-accel-buffering")).toBe("no");
    await res.body!.cancel();
  });

  it("send() writes an SSE event frame with the given event name and JSON payload", async () => {
    const { createSseResponse } = await import("../sse");
    let sendRef: ((event: string, data: unknown) => void) | null = null;
    const res = createSseResponse({
      onStart: (send) => {
        sendRef = send;
        return () => {};
      },
      keepaliveMs: 50,
    });
    const reader = res.body!.getReader();
    sendRef!("hello", { a: 1 });
    const { value } = await reader.read();
    const text = new TextDecoder().decode(value);
    expect(text).toBe(`event: hello\ndata: ${JSON.stringify({ a: 1 })}\n\n`);
    await reader.cancel();
  });

  it("emits a keepalive comment on the configured interval", async () => {
    vi.useFakeTimers();
    try {
      const { createSseResponse } = await import("../sse");
      const res = createSseResponse({ onStart: () => () => {}, keepaliveMs: 50 });
      const reader = res.body!.getReader();
      const pending = reader.read();
      await vi.advanceTimersByTimeAsync(50);
      const { value } = await pending;
      const text = new TextDecoder().decode(value);
      expect(text).toBe(`: keepalive\n\n`);
      await reader.cancel();
    } finally {
      vi.useRealTimers();
    }
  });

  it("clears the keepalive interval on teardown so no timer survives", async () => {
    vi.useFakeTimers();
    try {
      const { createSseResponse } = await import("../sse");
      const res = createSseResponse({ onStart: () => () => {}, keepaliveMs: 50 });
      await res.body!.cancel();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not call teardown a second time if send() throws after teardown already ran", async () => {
    const { createSseResponse } = await import("../sse");
    const teardown = vi.fn();
    let sendRef: ((event: string, data: unknown) => void) | null = null;
    const res = createSseResponse({
      onStart: (send) => {
        sendRef = send;
        return teardown;
      },
      keepaliveMs: 50,
    });
    await res.body!.cancel();
    expect(() => sendRef!("x", {})).not.toThrow();
    expect(teardown).toHaveBeenCalledTimes(1);
  });

  it("runs teardown immediately if the signal is already aborted before start", async () => {
    const { createSseResponse } = await import("../sse");
    const ac = new AbortController();
    ac.abort();
    const teardown = vi.fn();
    createSseResponse({ signal: ac.signal, onStart: () => teardown, keepaliveMs: 50 });
    expect(teardown).toHaveBeenCalledTimes(1);
  });
});
