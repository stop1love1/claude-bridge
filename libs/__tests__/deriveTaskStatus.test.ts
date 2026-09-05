import { describe, it, expect } from "vitest";
import { deriveTaskStatus, STATUS_PILL } from "../client/runStatus";
import type { Meta, Run, Task } from "../client/types";

const NOW = Date.parse("2026-09-04T15:30:00.000Z");

function task(over: Partial<Task> = {}): Task {
  return {
    id: "t_20260904_007",
    date: "2026-09-04",
    title: "x",
    body: "x",
    status: "doing",
    section: "DOING",
    checked: false,
    app: null,
    origin: "manual",
    workflowId: null,
    effort: null,
    createdAt: "2026-09-04T15:19:03.074Z",
    ...over,
  } as Task;
}

function run(over: Partial<Run>): Run {
  return {
    sessionId: "s-" + Math.random().toString(36).slice(2, 8),
    role: "coordinator",
    repo: "claude-bridge",
    status: "running",
    startedAt: "2026-09-04T15:19:03.320Z",
    endedAt: null,
    ...over,
  };
}

function meta(runs: Run[], over: Partial<Meta> = {}): Meta {
  return {
    taskId: "t_20260904_007",
    taskTitle: "x",
    taskBody: "x",
    taskStatus: "doing",
    taskSection: "DOING",
    taskChecked: false,
    createdAt: "2026-09-04T15:19:03.074Z",
    runs,
    ...over,
  };
}

describe("deriveTaskStatus", () => {
  it("reports a killed coordinator as cancelled, not idle", () => {
    // Regression: t_20260904_007 sat in DOING with its only run flipped to
    // cancelled by the kill route, and the board pill said "idle" — the
    // same label a task that was never started gets.
    const m = meta([run({ status: "cancelled", endedAt: "2026-09-04T15:19:27.244Z" })]);
    expect(deriveTaskStatus(task(), m, NOW)).toBe("cancelled");
    expect(STATUS_PILL.cancelled.label).toBe("cancelled");
  });

  it("reports a reaped coordinator as stale", () => {
    const m = meta([run({ status: "stale", endedAt: "2026-09-04T15:19:27.244Z" })]);
    expect(deriveTaskStatus(task(), m, NOW)).toBe("stale");
  });

  it("a cancelled coordinator outranks earlier finished children", () => {
    const m = meta([
      run({ status: "cancelled", endedAt: "2026-09-04T15:25:00.000Z" }),
      run({ role: "planner", status: "done", endedAt: "2026-09-04T15:24:00.000Z" }),
    ]);
    expect(deriveTaskStatus(task(), m, NOW)).toBe("cancelled");
  });

  it("a live run always wins", () => {
    const m = meta([
      run({ status: "cancelled", endedAt: "2026-09-04T15:19:27.244Z" }),
      run({ status: "running" }),
    ]);
    expect(deriveTaskStatus(task(), m, NOW)).toBe("running");
  });

  it("a queued run reads as spawning", () => {
    const m = meta([run({ status: "queued", startedAt: null })]);
    expect(deriveTaskStatus(task(), m, NOW)).toBe("spawning");
  });

  it("keeps the existing ladder: completed > failed > done > idle", () => {
    expect(deriveTaskStatus(task({ checked: true }), meta([run({ status: "failed" })]), NOW)).toBe("completed");
    expect(deriveTaskStatus(task(), meta([run({ status: "failed" }), run({ role: "coder", status: "done" })]), NOW)).toBe("failed");
    expect(deriveTaskStatus(task(), meta([run({ status: "done" })]), NOW)).toBe("done");
    expect(deriveTaskStatus(task(), meta([]), NOW)).toBe("idle");
    expect(deriveTaskStatus(task(), undefined, NOW)).toBe("spawning");
  });

  it("a brand-new task with no runs yet is spawning for 20s", () => {
    const created = new Date(NOW - 5_000).toISOString();
    expect(deriveTaskStatus(task({ createdAt: created }), meta([], { createdAt: created }), NOW)).toBe("spawning");
    const old = new Date(NOW - 60_000).toISOString();
    expect(deriveTaskStatus(task({ createdAt: old }), meta([], { createdAt: old }), NOW)).toBe("idle");
  });
});
