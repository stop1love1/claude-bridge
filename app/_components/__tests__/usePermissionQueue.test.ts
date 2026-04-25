import { describe, it, expect } from "vitest";
import { reduceQueue, type PendingRequest } from "../usePermissionQueue";

const SESSION_A = "11111111-1111-1111-1111-111111111111";
const SESSION_B = "22222222-2222-2222-2222-222222222222";

function req(requestId: string, sessionId = SESSION_A, tool = "Bash"): PendingRequest {
  return { sessionId, requestId, tool, input: { cmd: "ls" }, createdAt: "2026-04-25T00:00:00Z" };
}

describe("reduceQueue (H11)", () => {
  it("appends a new pending request to an empty queue", () => {
    const out = reduceQueue([], { kind: "pending", req: req("r1") });
    expect(out).toEqual([req("r1")]);
  });

  it("appends preserving FIFO order across sessions", () => {
    const out = [req("r1"), req("r2", SESSION_B)].reduce(
      (acc, r) => reduceQueue(acc, { kind: "pending", req: r }),
      [] as PendingRequest[],
    );
    expect(out.map((r) => r.requestId)).toEqual(["r1", "r2"]);
  });

  it("dedupes a pending event by requestId (idempotent)", () => {
    const seed = [req("r1")];
    const out = reduceQueue(seed, { kind: "pending", req: req("r1") });
    expect(out).toBe(seed); // same reference - no mutation, no copy
    expect(out.length).toBe(1);
  });

  it("answered drops the matching request from the queue", () => {
    const seed = [req("r1"), req("r2")];
    const out = reduceQueue(seed, { kind: "answered", requestId: "r1" });
    expect(out.map((r) => r.requestId)).toEqual(["r2"]);
  });

  it("answered for an unknown requestId is a no-op (same reference)", () => {
    const seed = [req("r1")];
    const out = reduceQueue(seed, { kind: "answered", requestId: "missing" });
    expect(out).toBe(seed);
  });

  it("multiple answered events progressively drain the queue", () => {
    let q: PendingRequest[] = [req("r1"), req("r2"), req("r3")];
    q = reduceQueue(q, { kind: "answered", requestId: "r2" });
    q = reduceQueue(q, { kind: "answered", requestId: "r1" });
    expect(q.map((r) => r.requestId)).toEqual(["r3"]);
  });

  it("interleaves pending + answered correctly", () => {
    let q: PendingRequest[] = [];
    q = reduceQueue(q, { kind: "pending", req: req("r1") });
    q = reduceQueue(q, { kind: "pending", req: req("r2") });
    q = reduceQueue(q, { kind: "answered", requestId: "r1" });
    q = reduceQueue(q, { kind: "pending", req: req("r3") });
    expect(q.map((r) => r.requestId)).toEqual(["r2", "r3"]);
  });
});
