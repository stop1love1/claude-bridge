import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import {
  createWorkflow,
  deleteWorkflow,
  getWorkflow,
  getSchedulerSettings,
  listWorkflows,
  recordWorkflowFire,
  setSchedulerSettings,
  updateWorkflow,
  DEFAULT_SETTINGS,
  _internal,
  _resetForTests,
  type StageInput,
} from "../workflowStore";

const { WORKFLOWS_FILE } = _internal;

// workflowStore binds its file to the real `.bridge-state` dir; snapshot
// and restore so a developer's live workflows aren't disturbed by the suite.
let saved: string | null = null;

beforeEach(() => {
  saved = existsSync(WORKFLOWS_FILE) ? readFileSync(WORKFLOWS_FILE, "utf8") : null;
  if (existsSync(WORKFLOWS_FILE)) rmSync(WORKFLOWS_FILE, { force: true });
  _resetForTests();
});

afterEach(() => {
  if (saved !== null) writeFileSync(WORKFLOWS_FILE, saved, "utf8");
  else if (existsSync(WORKFLOWS_FILE)) rmSync(WORKFLOWS_FILE, { force: true });
  _resetForTests();
});

const STAGES: StageInput[] = [
  { name: "Code", role: "coder", prompt: "implement it" },
  { name: "Test", role: "tester", prompt: "write + run tests" },
  { name: "Review", role: "reviewer", prompt: "review the change", verify: false },
];

describe("workflow CRUD (stages)", () => {
  it("creates a workflow with ordered stages and assigns stage ids", () => {
    const wf = createWorkflow({ name: "Ship", stages: STAGES });
    expect(wf.id).toMatch(/^wf_/);
    expect(wf.stages).toHaveLength(3);
    expect(wf.stages.map((s) => s.name)).toEqual(["Code", "Test", "Review"]);
    expect(wf.stages.every((s) => s.id.startsWith("st_"))).toBe(true);
    expect(wf.stages[0].verify).toBe(true); // defaults true
    expect(wf.stages[2].verify).toBe(false);
    expect(wf.schedule).toBeNull(); // manual by default
    expect(wf.nextRunAt).toBeNull();
    expect(listWorkflows()).toHaveLength(1);
  });

  it("rejects an empty stage list", () => {
    expect(() => createWorkflow({ name: "x", stages: [] })).toThrow(/at least one stage/);
  });

  it("rejects an invalid role", () => {
    expect(() =>
      createWorkflow({ name: "x", stages: [{ name: "S", role: "bad role!", prompt: "p" }] }),
    ).toThrow(/invalid role/);
  });

  it("rejects a stage missing name / prompt", () => {
    expect(() =>
      createWorkflow({ name: "x", stages: [{ name: "", role: "coder", prompt: "p" }] }),
    ).toThrow(/name required/);
    expect(() =>
      createWorkflow({ name: "x", stages: [{ name: "S", role: "coder", prompt: "" }] }),
    ).toThrow(/prompt required/);
  });

  it("computes nextRunAt only when enabled AND scheduled", () => {
    const manual = createWorkflow({ name: "m", stages: STAGES });
    expect(manual.nextRunAt).toBeNull();
    const scheduled = createWorkflow({
      name: "s",
      stages: STAGES,
      schedule: { kind: "interval", everyMs: 3_600_000 },
    });
    expect(scheduled.nextRunAt).toBeGreaterThan(Date.now());
  });

  it("replaces the stage list on update", () => {
    const wf = createWorkflow({ name: "w", stages: STAGES });
    const updated = updateWorkflow(wf.id, {
      stages: [{ name: "Only", role: "coder", prompt: "do" }],
    });
    expect(updated?.stages).toHaveLength(1);
    expect(updated?.stages[0].name).toBe("Only");
  });

  it("clears nextRunAt when the schedule is removed", () => {
    const wf = createWorkflow({
      name: "w",
      stages: STAGES,
      schedule: { kind: "daily", time: "09:00" },
    });
    expect(wf.nextRunAt).toBeGreaterThan(0);
    const off = updateWorkflow(wf.id, { schedule: null });
    expect(off?.schedule).toBeNull();
    expect(off?.nextRunAt).toBeNull();
  });

  it("deletes a workflow", () => {
    const wf = createWorkflow({ name: "w", stages: STAGES });
    expect(deleteWorkflow(wf.id)).toBe(true);
    expect(listWorkflows()).toHaveLength(0);
    expect(deleteWorkflow(wf.id)).toBe(false);
  });

  it("records a run: stamps lastRunAt, prepends history", () => {
    const wf = createWorkflow({ name: "w", stages: STAGES });
    recordWorkflowFire(wf.id, "t_20260530_001", Date.now());
    const after = getWorkflow(wf.id)!;
    expect(after.lastRunAt).not.toBeNull();
    expect(after.history[0]).toBe("t_20260530_001");
    // manual workflow → no schedule → nextRunAt stays null
    expect(after.nextRunAt).toBeNull();
  });

  it("advances nextRunAt on fire for a scheduled workflow", () => {
    const wf = createWorkflow({
      name: "w",
      stages: STAGES,
      schedule: { kind: "interval", everyMs: 60_000 },
    });
    const fireAt = Date.now();
    recordWorkflowFire(wf.id, "t_20260530_002", fireAt);
    expect(getWorkflow(wf.id)!.nextRunAt).toBe(fireAt + 60_000);
  });
});

describe("scheduler settings", () => {
  it("returns defaults initially", () => {
    expect(getSchedulerSettings()).toEqual(DEFAULT_SETTINGS);
  });

  it("clamps the concurrency cap into [1, 10]", () => {
    expect(setSchedulerSettings({ maxConcurrentRuns: 0 }).maxConcurrentRuns).toBe(1);
    expect(setSchedulerSettings({ maxConcurrentRuns: 999 }).maxConcurrentRuns).toBe(10);
    expect(setSchedulerSettings({ maxConcurrentRuns: 3 }).maxConcurrentRuns).toBe(3);
  });

  it("toggles cronEnabled", () => {
    expect(setSchedulerSettings({ cronEnabled: false }).cronEnabled).toBe(false);
    expect(setSchedulerSettings({ cronEnabled: true }).cronEnabled).toBe(true);
  });
});
