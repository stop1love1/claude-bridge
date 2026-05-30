import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  answerShareRequest,
  consumeShareRequest,
  createShareRequest,
  getShareRequest,
  listPendingShareRequests,
  _resetForTests,
} from "../shareApprovals";

beforeEach(() => _resetForTests());
afterEach(() => _resetForTests());

const ARGS = {
  shareId: "shr_1",
  taskId: "t_1",
  displayName: "Alice",
  ip: "1.2.3.4",
  userAgent: "UA/1.0",
};

describe("createShareRequest", () => {
  it("mints a candidate device id and a pending entry", () => {
    const e = createShareRequest(ARGS);
    expect(e.status).toBe("pending");
    expect(e.did).toMatch(/^gdv_/);
    expect(e.id).toMatch(/^sreq_/);
    expect(getShareRequest(e.id)?.shareId).toBe("shr_1");
  });

  it("caps the display name and user agent", () => {
    const e = createShareRequest({ ...ARGS, displayName: "x".repeat(200), userAgent: "y".repeat(1000) });
    expect(e.displayName.length).toBe(80);
    expect(e.userAgent.length).toBe(400);
  });
});

describe("answerShareRequest", () => {
  it("approves and is idempotent on a second answer", () => {
    const e = createShareRequest(ARGS);
    expect(answerShareRequest(e.id, "approved")?.status).toBe("approved");
    // A second answer doesn't flip an already-decided request.
    expect(answerShareRequest(e.id, "denied")?.status).toBe("approved");
  });

  it("denies with a reason", () => {
    const e = createShareRequest(ARGS);
    const d = answerShareRequest(e.id, "denied", "nope");
    expect(d?.status).toBe("denied");
    expect(d?.reason).toBe("nope");
  });

  it("returns null for an unknown id", () => {
    expect(answerShareRequest("sreq_missing", "approved")).toBeNull();
  });
});

describe("listing + consume", () => {
  it("lists only pending entries, newest first", () => {
    const a = createShareRequest(ARGS);
    const b = createShareRequest({ ...ARGS, displayName: "Bob" });
    answerShareRequest(a.id, "approved");
    const pending = listPendingShareRequests();
    expect(pending.map((p) => p.id)).toContain(b.id);
    expect(pending.map((p) => p.id)).not.toContain(a.id);
  });

  it("consume drops the entry", () => {
    const e = createShareRequest(ARGS);
    consumeShareRequest(e.id);
    expect(getShareRequest(e.id)).toBeNull();
  });
});
