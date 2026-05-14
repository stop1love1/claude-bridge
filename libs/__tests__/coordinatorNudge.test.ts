import { describe, it, expect } from "vitest";
import {
  decideNudge,
  shouldFinalizeDeferredCoordinator,
} from "../coordinatorNudge";
import type { Run } from "../meta";

const COORD_SID = "11111111-2222-3333-4444-555555555555";
const CHILD_A_SID = "aaaaaaaa-2222-3333-4444-555555555555";
const CHILD_B_SID = "bbbbbbbb-2222-3333-4444-555555555555";

function coordinator(overrides: Partial<Run> = {}): Run {
  return {
    sessionId: COORD_SID,
    role: "coordinator",
    repo: "claude-bridge",
    status: "done",
    startedAt: "2026-05-14T10:00:00Z",
    endedAt: "2026-05-14T10:00:30Z",
    ...overrides,
  };
}

function child(sid: string, status: Run["status"], overrides: Partial<Run> = {}): Run {
  return {
    sessionId: sid,
    role: "coder",
    repo: "edusoft-lms",
    status,
    startedAt: "2026-05-14T10:01:00Z",
    endedAt: status === "done" || status === "failed" ? "2026-05-14T10:02:00Z" : null,
    parentSessionId: COORD_SID,
    ...overrides,
  };
}

const NEVER_ALIVE = () => false;
const ALWAYS_ALIVE = () => true;

describe("decideNudge", () => {
  it("nudges when all children are terminal and coordinator is idle", () => {
    const decision = decideNudge({
      parentSessionId: COORD_SID,
      runs: [coordinator(), child(CHILD_A_SID, "done"), child(CHILD_B_SID, "failed")],
      isAlive: NEVER_ALIVE,
      lastNudgeAt: null,
      now: 1_000_000,
    });
    expect(decision.kind).toBe("nudge");
    if (decision.kind === "nudge") {
      expect(decision.children).toHaveLength(2);
    }
  });

  it("skips when no coordinator row exists for the given parentSessionId", () => {
    const decision = decideNudge({
      parentSessionId: COORD_SID,
      // No coordinator row in runs[]
      runs: [child(CHILD_A_SID, "done")],
      isAlive: NEVER_ALIVE,
      lastNudgeAt: null,
      now: 1_000_000,
    });
    expect(decision).toEqual({ kind: "skip", reason: "no coordinator row" });
  });

  it("skips when the coordinator has no children yet", () => {
    const decision = decideNudge({
      parentSessionId: COORD_SID,
      runs: [coordinator()],
      isAlive: NEVER_ALIVE,
      lastNudgeAt: null,
      now: 1_000_000,
    });
    expect(decision).toEqual({ kind: "skip", reason: "no children" });
  });

  it("skips when at least one child is still running (covers the retry-spawn race)", () => {
    const decision = decideNudge({
      parentSessionId: COORD_SID,
      runs: [
        coordinator(),
        child(CHILD_A_SID, "done"),
        child(CHILD_B_SID, "running"),
      ],
      isAlive: NEVER_ALIVE,
      lastNudgeAt: null,
      now: 1_000_000,
    });
    expect(decision).toEqual({ kind: "skip", reason: "child still running" });
  });

  it("skips when the coordinator process is still alive (let it discover state itself)", () => {
    const decision = decideNudge({
      parentSessionId: COORD_SID,
      runs: [coordinator(), child(CHILD_A_SID, "done")],
      isAlive: ALWAYS_ALIVE,
      lastNudgeAt: null,
      now: 1_000_000,
    });
    expect(decision).toEqual({ kind: "skip", reason: "coordinator alive" });
  });

  it("skips when a recent nudge was already sent (debounce)", () => {
    const decision = decideNudge({
      parentSessionId: COORD_SID,
      runs: [coordinator(), child(CHILD_A_SID, "done")],
      isAlive: NEVER_ALIVE,
      lastNudgeAt: 999_000,
      now: 1_000_000, // 1s after — well within the 5s debounce
    });
    expect(decision).toEqual({ kind: "skip", reason: "debounced" });
  });

  it("nudges again once the debounce window elapses", () => {
    const decision = decideNudge({
      parentSessionId: COORD_SID,
      runs: [coordinator(), child(CHILD_A_SID, "done")],
      isAlive: NEVER_ALIVE,
      lastNudgeAt: 999_000,
      now: 999_000 + 5_001, // 1ms past the 5s window
    });
    expect(decision.kind).toBe("nudge");
  });

  it("treats `stale` children as terminal", () => {
    const decision = decideNudge({
      parentSessionId: COORD_SID,
      runs: [coordinator(), child(CHILD_A_SID, "stale")],
      isAlive: NEVER_ALIVE,
      lastNudgeAt: null,
      now: 1_000_000,
    });
    expect(decision.kind).toBe("nudge");
  });

  it("ignores children whose parentSessionId points at a different coordinator", () => {
    const decision = decideNudge({
      parentSessionId: COORD_SID,
      runs: [
        coordinator(),
        child(CHILD_A_SID, "done"),
        // This one belongs to some other coordinator — must be ignored.
        child(CHILD_B_SID, "running", { parentSessionId: "other-coord" }),
      ],
      isAlive: NEVER_ALIVE,
      lastNudgeAt: null,
      now: 1_000_000,
    });
    expect(decision.kind).toBe("nudge");
    if (decision.kind === "nudge") {
      expect(decision.children.map((c) => c.sessionId)).toEqual([CHILD_A_SID]);
    }
  });
});

describe("shouldFinalizeDeferredCoordinator (2b deferred-DONE finalizer)", () => {
  it("returns true when coordinator is `running`, process gone, all children terminal (deferred-DONE case)", () => {
    expect(
      shouldFinalizeDeferredCoordinator({
        parentSessionId: COORD_SID,
        runs: [
          coordinator({ status: "running", endedAt: null }),
          child(CHILD_A_SID, "done"),
          child(CHILD_B_SID, "failed"),
        ],
        isAlive: NEVER_ALIVE,
      }),
    ).toBe(true);
  });

  it("returns false when coordinator status is already `done` (no deferral happened)", () => {
    expect(
      shouldFinalizeDeferredCoordinator({
        parentSessionId: COORD_SID,
        runs: [coordinator({ status: "done" }), child(CHILD_A_SID, "done")],
        isAlive: NEVER_ALIVE,
      }),
    ).toBe(false);
  });

  it("returns false when coordinator process is still alive (running for real, not deferred)", () => {
    expect(
      shouldFinalizeDeferredCoordinator({
        parentSessionId: COORD_SID,
        runs: [
          coordinator({ status: "running", endedAt: null }),
          child(CHILD_A_SID, "done"),
        ],
        isAlive: ALWAYS_ALIVE,
      }),
    ).toBe(false);
  });

  it("returns false when at least one child is still queued/running", () => {
    expect(
      shouldFinalizeDeferredCoordinator({
        parentSessionId: COORD_SID,
        runs: [
          coordinator({ status: "running", endedAt: null }),
          child(CHILD_A_SID, "running"),
        ],
        isAlive: NEVER_ALIVE,
      }),
    ).toBe(false);
  });

  it("returns false when no coordinator row exists for the given parentSessionId", () => {
    expect(
      shouldFinalizeDeferredCoordinator({
        parentSessionId: COORD_SID,
        runs: [child(CHILD_A_SID, "done")],
        isAlive: NEVER_ALIVE,
      }),
    ).toBe(false);
  });
});

