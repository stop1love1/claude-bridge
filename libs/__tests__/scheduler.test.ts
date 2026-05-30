import { describe, expect, it } from "vitest";
import { dueWorkflows, planAutoDispatch } from "../scheduler";
import type { Workflow, SchedulerSettings } from "../workflowStore";
import type { Task } from "../tasks";

function wf(over: Partial<Workflow>): Workflow {
  return {
    id: "wf_x",
    name: "w",
    enabled: true,
    schedule: { kind: "interval", everyMs: 60_000 },
    app: null,
    title: "t",
    body: "",
    createdAt: "2026-05-30T00:00:00.000Z",
    lastRunAt: null,
    nextRunAt: 1000,
    history: [],
    ...over,
  };
}

function task(over: Partial<Task>): Task {
  return {
    id: "t_20260530_001",
    date: "2026-05-30",
    title: "t",
    body: "",
    status: "todo",
    section: "TODO",
    checked: false,
    app: null,
    auto: true,
    origin: "manual",
    workflowId: null,
    ...over,
  };
}

const SETTINGS: SchedulerSettings = { autoDispatchEnabled: true, maxConcurrentCoordinators: 2 };

describe("dueWorkflows", () => {
  it("returns enabled workflows whose nextRunAt has passed", () => {
    const list = [
      wf({ id: "a", nextRunAt: 500 }),
      wf({ id: "b", nextRunAt: 2000 }),       // future
      wf({ id: "c", enabled: false, nextRunAt: 500 }), // disabled
      wf({ id: "d", nextRunAt: null }),        // no schedule
    ];
    const due = dueWorkflows(list, 1000);
    expect(due.map((w) => w.id)).toEqual(["a"]);
  });

  it("fires exactly at nextRunAt (>=)", () => {
    expect(dueWorkflows([wf({ id: "a", nextRunAt: 1000 })], 1000).map((w) => w.id)).toEqual(["a"]);
  });
});

describe("planAutoDispatch", () => {
  const candidates = [
    task({ id: "t_20260530_001" }),
    task({ id: "t_20260530_002" }),
    task({ id: "t_20260530_003" }),
  ];

  it("returns nothing when auto-dispatch is disabled", () => {
    expect(
      planAutoDispatch({ settings: { ...SETTINGS, autoDispatchEnabled: false }, busyCount: 0, candidates }),
    ).toEqual([]);
  });

  it("fills only the open slots (cap minus busy)", () => {
    const picked = planAutoDispatch({ settings: SETTINGS, busyCount: 0, candidates });
    expect(picked.map((t) => t.id)).toEqual(["t_20260530_001", "t_20260530_002"]); // cap 2
  });

  it("respects already-busy coordinators", () => {
    const picked = planAutoDispatch({ settings: SETTINGS, busyCount: 1, candidates });
    expect(picked.map((t) => t.id)).toEqual(["t_20260530_001"]); // 2 - 1 = 1 slot
  });

  it("returns nothing when at or over the cap", () => {
    expect(planAutoDispatch({ settings: SETTINGS, busyCount: 2, candidates })).toEqual([]);
    expect(planAutoDispatch({ settings: SETTINGS, busyCount: 5, candidates })).toEqual([]);
  });

  it("returns nothing when there are no candidates", () => {
    expect(planAutoDispatch({ settings: SETTINGS, busyCount: 0, candidates: [] })).toEqual([]);
  });
});
