import { describe, it, expect, beforeEach } from "vitest";
import {
  appendPartial,
  dropOnArrival,
  clearPartials,
  subscribePartialKeys,
  subscribePartialText,
  __resetPartialsStoreForTests,
} from "../partialsStore";

const S = "session-a";

function keysOf(sessionId: string): readonly string[] {
  return subscribePartialKeys(sessionId).getSnapshot();
}
function textOf(sessionId: string, messageId: string): string {
  return subscribePartialText(sessionId, messageId).getSnapshot();
}

// Mirrors the module-private PARTIAL_CAP_BYTES (256 * 1024). Not exported,
// so re-declared here; the cap is genuine observable behaviour (it stops a
// single streaming message from growing without bound).
const CAP = 256 * 1024;

beforeEach(() => {
  __resetPartialsStoreForTests();
});

describe("partialsStore — token-delta accumulation", () => {
  it("concatenates successive token deltas for a message id", () => {
    appendPartial(S, "m1", "Hel");
    appendPartial(S, "m1", "lo");
    appendPartial(S, "m1", " world");
    expect(textOf(S, "m1")).toBe("Hello world");
  });

  it("keeps deltas for different message ids independent", () => {
    appendPartial(S, "m1", "alpha");
    appendPartial(S, "m2", "beta");
    expect(textOf(S, "m1")).toBe("alpha");
    expect(textOf(S, "m2")).toBe("beta");
  });

  it("ignores empty-string appends (no-op)", () => {
    appendPartial(S, "m1", "");
    expect(textOf(S, "m1")).toBe("");
    expect(keysOf(S)).toEqual([]);
  });

  it("returns an empty string snapshot for an unknown session/message", () => {
    expect(textOf("nope", "mX")).toBe("");
  });

  it("stops accumulating once the byte cap is reached (eviction)", () => {
    appendPartial(S, "big", "a".repeat(CAP)); // reaches the cap exactly
    appendPartial(S, "big", "X"); // must be dropped: length is already >= cap
    const text = textOf(S, "big");
    expect(text.length).toBe(CAP);
    expect(text.endsWith("X")).toBe(false);
  });
});

describe("partialsStore — key ordering", () => {
  it("reports message ids in first-seen (insertion) order", () => {
    appendPartial(S, "m1", "a");
    appendPartial(S, "m3", "c");
    appendPartial(S, "m2", "b");
    expect(keysOf(S)).toEqual(["m1", "m3", "m2"]);
  });

  it("does not reorder or duplicate a key when appended to again", () => {
    appendPartial(S, "m1", "a");
    appendPartial(S, "m2", "b");
    appendPartial(S, "m1", "a2");
    expect(keysOf(S)).toEqual(["m1", "m2"]);
    expect(textOf(S, "m1")).toBe("aa2");
  });
});

describe("partialsStore — key/text subscriptions", () => {
  it("notifies key subscribers only when a NEW id first appears", () => {
    let calls = 0;
    subscribePartialKeys(S).subscribe(() => {
      calls++;
    });
    appendPartial(S, "m1", "a"); // new id -> fires
    appendPartial(S, "m1", "b"); // same id -> no key change, no fire
    appendPartial(S, "m2", "c"); // new id -> fires
    expect(calls).toBe(2);
  });

  it("notifies a text subscriber for its own id only", () => {
    let m1 = 0;
    subscribePartialText(S, "m1").subscribe(() => {
      m1++;
    });
    appendPartial(S, "m1", "a");
    appendPartial(S, "m1", "b");
    appendPartial(S, "m2", "c"); // different id -> must not fire m1's listener
    expect(m1).toBe(2);
  });

  it("stops notifying after unsubscribe", () => {
    let calls = 0;
    const unsub = subscribePartialKeys(S).subscribe(() => {
      calls++;
    });
    appendPartial(S, "m1", "a");
    unsub();
    appendPartial(S, "m2", "b");
    expect(calls).toBe(1);
  });

  it("keeps notifying remaining listeners when one throws", () => {
    let good = 0;
    subscribePartialKeys(S).subscribe(() => {
      throw new Error("boom");
    });
    subscribePartialKeys(S).subscribe(() => {
      good++;
    });
    appendPartial(S, "m1", "a");
    expect(good).toBe(1);
  });
});

describe("partialsStore — dropOnArrival", () => {
  it("removes only the ids that have arrived", () => {
    appendPartial(S, "m1", "a");
    appendPartial(S, "m2", "b");
    appendPartial(S, "m3", "c");
    dropOnArrival(S, ["m2"]);
    expect(keysOf(S)).toEqual(["m1", "m3"]);
    expect(textOf(S, "m2")).toBe("");
  });

  it("also evicts any remaining live: placeholder keys", () => {
    appendPartial(S, "live:x", "streaming");
    appendPartial(S, "m1", "real");
    dropOnArrival(S, []); // nothing arrived, but live: keys are swept
    expect(keysOf(S)).toEqual(["m1"]);
    expect(textOf(S, "live:x")).toBe("");
  });

  it("is a no-op (no notification) when nothing matches", () => {
    appendPartial(S, "m1", "a");
    let calls = 0;
    subscribePartialKeys(S).subscribe(() => {
      calls++;
    });
    dropOnArrival(S, ["ghost"]);
    expect(calls).toBe(0);
    expect(keysOf(S)).toEqual(["m1"]);
  });

  it("does not throw for an unknown session", () => {
    expect(() => dropOnArrival("unknown", ["x"])).not.toThrow();
  });
});

describe("partialsStore — clearPartials / reset", () => {
  it("clears every partial for a session and notifies", () => {
    appendPartial(S, "m1", "a");
    appendPartial(S, "m2", "b");
    let keyCalls = 0;
    subscribePartialKeys(S).subscribe(() => {
      keyCalls++;
    });
    clearPartials(S);
    expect(keysOf(S)).toEqual([]);
    expect(textOf(S, "m1")).toBe("");
    expect(keyCalls).toBe(1);
  });

  it("is a no-op when there is nothing to clear", () => {
    let calls = 0;
    subscribePartialKeys(S).subscribe(() => {
      calls++;
    });
    clearPartials(S);
    expect(calls).toBe(0);
  });

  it("__resetPartialsStoreForTests wipes all sessions", () => {
    appendPartial(S, "m1", "a");
    appendPartial("other", "m1", "b");
    __resetPartialsStoreForTests();
    expect(keysOf(S)).toEqual([]);
    expect(keysOf("other")).toEqual([]);
    expect(textOf(S, "m1")).toBe("");
  });
});
