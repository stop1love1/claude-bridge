import { describe, it, expect, beforeEach } from "vitest";
import {
  _resetAllQueuesForTest,
  clearQueue,
  dequeueMessage,
  enqueueMessage,
  queueLength,
  type QueuedMessage,
} from "../messageQueue";

function mkMsg(text: string): QueuedMessage {
  return {
    message: text,
    cwd: "/tmp",
    settings: {},
    settingsPath: "/tmp/settings.json",
    enqueuedAt: Date.now(),
  };
}

describe("messageQueue", () => {
  beforeEach(() => {
    _resetAllQueuesForTest();
  });

  it("queueLength is 0 for an unknown sessionId", () => {
    expect(queueLength("sid-missing")).toBe(0);
  });

  it("enqueue returns 1-based position and length tracks pushes", () => {
    expect(enqueueMessage("sid-a", mkMsg("first"))).toBe(1);
    expect(enqueueMessage("sid-a", mkMsg("second"))).toBe(2);
    expect(enqueueMessage("sid-a", mkMsg("third"))).toBe(3);
    expect(queueLength("sid-a")).toBe(3);
  });

  it("dequeue is FIFO and decrements length, returns null on empty", () => {
    enqueueMessage("sid-a", mkMsg("one"));
    enqueueMessage("sid-a", mkMsg("two"));
    expect(dequeueMessage("sid-a")?.message).toBe("one");
    expect(queueLength("sid-a")).toBe(1);
    expect(dequeueMessage("sid-a")?.message).toBe("two");
    expect(queueLength("sid-a")).toBe(0);
    expect(dequeueMessage("sid-a")).toBeNull();
  });

  it("queues are isolated per sessionId", () => {
    enqueueMessage("sid-a", mkMsg("a-one"));
    enqueueMessage("sid-b", mkMsg("b-one"));
    enqueueMessage("sid-a", mkMsg("a-two"));
    expect(queueLength("sid-a")).toBe(2);
    expect(queueLength("sid-b")).toBe(1);
    expect(dequeueMessage("sid-a")?.message).toBe("a-one");
    expect(dequeueMessage("sid-b")?.message).toBe("b-one");
    expect(queueLength("sid-a")).toBe(1);
    expect(queueLength("sid-b")).toBe(0);
  });

  it("clearQueue returns the dropped count and empties the slot", () => {
    enqueueMessage("sid-a", mkMsg("one"));
    enqueueMessage("sid-a", mkMsg("two"));
    enqueueMessage("sid-a", mkMsg("three"));
    expect(clearQueue("sid-a")).toBe(3);
    expect(queueLength("sid-a")).toBe(0);
    expect(dequeueMessage("sid-a")).toBeNull();
  });

  it("clearQueue on empty queue returns 0", () => {
    expect(clearQueue("sid-never-touched")).toBe(0);
  });

  it("re-enqueue after empty restarts position numbering at 1", () => {
    enqueueMessage("sid-a", mkMsg("one"));
    dequeueMessage("sid-a");
    expect(queueLength("sid-a")).toBe(0);
    expect(enqueueMessage("sid-a", mkMsg("two"))).toBe(1);
  });
});
