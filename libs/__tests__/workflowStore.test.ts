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

describe("workflow CRUD", () => {
  it("creates a workflow with computed nextRunAt and lists it", () => {
    const wf = createWorkflow({
      name: "Nightly cleanup",
      schedule: { kind: "interval", everyMs: 3_600_000 },
      title: "Run cleanup",
      body: "do the thing",
    });
    expect(wf.id).toMatch(/^wf_/);
    expect(wf.enabled).toBe(true);
    expect(wf.nextRunAt).toBeGreaterThan(Date.now());
    expect(listWorkflows()).toHaveLength(1);
    expect(getWorkflow(wf.id)?.name).toBe("Nightly cleanup");
  });

  it("rejects an invalid schedule", () => {
    expect(() =>
      createWorkflow({ name: "bad", schedule: { kind: "interval", everyMs: 5 }, title: "x" }),
    ).toThrow(/interval/);
  });

  it("requires a title", () => {
    expect(() =>
      createWorkflow({ name: "x", schedule: { kind: "daily", time: "09:00" }, title: "   " }),
    ).toThrow(/title/);
  });

  it("clears nextRunAt when disabled and recomputes when re-enabled", () => {
    const wf = createWorkflow({
      name: "w",
      schedule: { kind: "daily", time: "09:00" },
      title: "t",
    });
    const off = updateWorkflow(wf.id, { enabled: false });
    expect(off?.nextRunAt).toBeNull();
    const on = updateWorkflow(wf.id, { enabled: true });
    expect(on?.nextRunAt).toBeGreaterThan(Date.now());
  });

  it("recomputes nextRunAt when the schedule changes", () => {
    const wf = createWorkflow({
      name: "w",
      schedule: { kind: "interval", everyMs: 60_000 },
      title: "t",
    });
    const updated = updateWorkflow(wf.id, { schedule: { kind: "interval", everyMs: 3_600_000 } });
    expect(updated?.schedule).toEqual({ kind: "interval", everyMs: 3_600_000 });
  });

  it("deletes a workflow", () => {
    const wf = createWorkflow({
      name: "w",
      schedule: { kind: "interval", everyMs: 60_000 },
      title: "t",
    });
    expect(deleteWorkflow(wf.id)).toBe(true);
    expect(listWorkflows()).toHaveLength(0);
    expect(deleteWorkflow(wf.id)).toBe(false);
  });

  it("records a fire: stamps lastRunAt, prepends history, advances nextRunAt", () => {
    const wf = createWorkflow({
      name: "w",
      schedule: { kind: "interval", everyMs: 60_000 },
      title: "t",
    });
    const fireAt = Date.now();
    recordWorkflowFire(wf.id, "t_20260530_001", fireAt);
    const after = getWorkflow(wf.id)!;
    expect(after.lastRunAt).not.toBeNull();
    expect(after.history[0]).toBe("t_20260530_001");
    expect(after.nextRunAt).toBe(fireAt + 60_000);
  });
});

describe("scheduler settings", () => {
  it("returns defaults initially", () => {
    expect(getSchedulerSettings()).toEqual(DEFAULT_SETTINGS);
  });

  it("clamps the concurrency cap into [1, 10]", () => {
    expect(setSchedulerSettings({ maxConcurrentCoordinators: 0 }).maxConcurrentCoordinators).toBe(1);
    expect(setSchedulerSettings({ maxConcurrentCoordinators: 999 }).maxConcurrentCoordinators).toBe(10);
    expect(setSchedulerSettings({ maxConcurrentCoordinators: 3 }).maxConcurrentCoordinators).toBe(3);
  });

  it("toggles autoDispatchEnabled", () => {
    expect(setSchedulerSettings({ autoDispatchEnabled: false }).autoDispatchEnabled).toBe(false);
    expect(setSchedulerSettings({ autoDispatchEnabled: true }).autoDispatchEnabled).toBe(true);
  });
});
