import { describe, it, expect } from "vitest";
import { isCoordinatorOrchestrating } from "../client/coordinatorStatus";
import type { Run } from "../client/types";

const COORD_SID = "11111111-2222-3333-4444-555555555555";
const CHILD_SID = "aaaaaaaa-2222-3333-4444-555555555555";

function coord(status: Run["status"]): Run {
  return {
    sessionId: COORD_SID,
    role: "coordinator",
    repo: "claude-bridge",
    status,
    startedAt: "2026-05-14T10:00:00Z",
    endedAt: status === "running" ? null : "2026-05-14T10:00:30Z",
  };
}

function child(status: Run["status"], parentSessionId = COORD_SID): Run {
  return {
    sessionId: CHILD_SID,
    role: "coder",
    repo: "edusoft-lms",
    status,
    startedAt: "2026-05-14T10:01:00Z",
    endedAt: status === "done" || status === "failed" ? "2026-05-14T10:02:00Z" : null,
    parentSessionId,
  };
}

describe("isCoordinatorOrchestrating", () => {
  it("returns true when coordinator is `done` but a child is still running", () => {
    expect(
      isCoordinatorOrchestrating({
        coordinator: coord("done"),
        runs: [coord("done"), child("running")],
      }),
    ).toBe(true);
  });

  it("returns true when coordinator is `failed` but a child is still queued", () => {
    expect(
      isCoordinatorOrchestrating({
        coordinator: coord("failed"),
        runs: [coord("failed"), child("queued")],
      }),
    ).toBe(true);
  });

  it("returns false when coordinator is `running` (literal RUNNING already covers it)", () => {
    expect(
      isCoordinatorOrchestrating({
        coordinator: coord("running"),
        runs: [coord("running"), child("running")],
      }),
    ).toBe(false);
  });

  it("returns false when every child is also terminal (task is genuinely settled)", () => {
    expect(
      isCoordinatorOrchestrating({
        coordinator: coord("done"),
        runs: [coord("done"), child("done"), child("failed")],
      }),
    ).toBe(false);
  });

  it("returns false when there are no other runs (just the coordinator)", () => {
    expect(
      isCoordinatorOrchestrating({
        coordinator: coord("done"),
        runs: [coord("done")],
      }),
    ).toBe(false);
  });

  it("treats `stale` as terminal — does NOT count toward orchestration", () => {
    // A stale child shouldn't keep the badge pulsing forever; the
    // staleRunReaper marks runs stale precisely because they're not
    // active anymore.
    expect(
      isCoordinatorOrchestrating({
        coordinator: coord("done"),
        runs: [coord("done"), child("stale")],
      }),
    ).toBe(false);
  });
});
