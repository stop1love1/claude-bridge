import { describe, expect, it } from "vitest";
import { dueWorkflows } from "../scheduler";
import type { Workflow } from "../workflowStore";

function wf(over: Partial<Workflow>): Workflow {
  return {
    id: "wf_x",
    name: "w",
    app: null,
    stages: [{ id: "st_1", name: "Code", role: "coder", prompt: "do", verify: true }],
    enabled: true,
    schedule: { kind: "interval", everyMs: 60_000 },
    createdAt: "2026-05-30T00:00:00.000Z",
    lastRunAt: null,
    nextRunAt: 1000,
    history: [],
    ...over,
  };
}

describe("dueWorkflows", () => {
  it("returns enabled, scheduled workflows whose nextRunAt has passed", () => {
    const list = [
      wf({ id: "a", nextRunAt: 500 }),
      wf({ id: "b", nextRunAt: 2000 }),                  // future
      wf({ id: "c", enabled: false, nextRunAt: 500 }),   // disabled
      wf({ id: "d", schedule: null, nextRunAt: 500 }),   // manual-only
      wf({ id: "e", nextRunAt: null }),                  // no next time
    ];
    expect(dueWorkflows(list, 1000).map((w) => w.id)).toEqual(["a"]);
  });

  it("fires exactly at nextRunAt (>=)", () => {
    expect(dueWorkflows([wf({ id: "a", nextRunAt: 1000 })], 1000).map((w) => w.id)).toEqual(["a"]);
  });
});
