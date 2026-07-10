import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { Task } from "../tasks";
import type { Meta, Run } from "../meta";

const listTasksMock = vi.fn<() => Task[]>();
vi.mock("../tasksStore", () => ({
  listTasks: () => listTasksMock(),
}));

const readMetaMock = vi.fn<(dir: string) => Meta | null>();
vi.mock("../meta", () => ({
  readMeta: (dir: string) => readMetaMock(dir),
}));

const spawnMock = vi.fn<(task: Task) => Promise<string | null>>();
vi.mock("../coordinator", () => ({
  spawnCoordinatorForTask: (task: Task) => spawnMock(task),
}));

import {
  autoQueueTick,
  pickNextTodoTask,
  readAutoQueueConfig,
  writeAutoQueueConfig,
  _resetForTests,
  _internal,
} from "../autoQueue";

const { CONFIG_FILE } = _internal;
let savedConfig: string | null = null;

function task(over: Partial<Task> & { id: string }): Task {
  const base: Task = {
    id: over.id,
    date: over.id.slice(2, 10),
    title: "t",
    body: "b",
    status: "todo",
    section: "TODO",
    checked: false,
  };
  return { ...base, ...over };
}

function run(over: Partial<Run> = {}): Run {
  return {
    sessionId: "s_" + Math.random().toString(36).slice(2),
    role: "coordinator",
    repo: "bridge",
    status: "running",
    startedAt: null,
    endedAt: null,
    ...over,
  };
}

function meta(runs: Run[] = []): Meta {
  return {
    taskId: "t_20260701_001",
    taskTitle: "t",
    taskBody: "b",
    taskStatus: "todo",
    taskSection: "TODO",
    taskChecked: false,
    createdAt: "2026-07-01T00:00:00Z",
    runs,
  };
}

beforeEach(() => {
  savedConfig = existsSync(CONFIG_FILE) ? readFileSync(CONFIG_FILE, "utf8") : null;
  if (existsSync(CONFIG_FILE)) rmSync(CONFIG_FILE, { force: true });
  _resetForTests();
  listTasksMock.mockReset();
  readMetaMock.mockReset();
  spawnMock.mockReset();
  spawnMock.mockResolvedValue("new-session-id");
});
afterEach(() => {
  if (savedConfig !== null) writeFileSync(CONFIG_FILE, savedConfig, "utf8");
  else if (existsSync(CONFIG_FILE)) rmSync(CONFIG_FILE, { force: true });
  _resetForTests();
});

describe("autoQueue config", () => {
  it("defaults to disabled / maxConcurrent 1", () => {
    const c = readAutoQueueConfig();
    expect(c).toEqual({ enabled: false, maxConcurrent: 1 });
  });
  it("patches + persists", () => {
    writeAutoQueueConfig({ enabled: true, maxConcurrent: 3 });
    expect(readAutoQueueConfig()).toEqual({ enabled: true, maxConcurrent: 3 });
  });
  it("clamps maxConcurrent to 1..20", () => {
    expect(writeAutoQueueConfig({ maxConcurrent: 0 }).maxConcurrent).toBe(1);
    expect(writeAutoQueueConfig({ maxConcurrent: 999 }).maxConcurrent).toBe(20);
  });
});

describe("pickNextTodoTask (pure)", () => {
  it("picks the oldest TODO task by id", () => {
    const tasks = [task({ id: "t_20260702_001" }), task({ id: "t_20260701_001" })];
    const picked = pickNextTodoTask(tasks, new Map());
    expect(picked?.id).toBe("t_20260701_001");
  });
  it("skips non-TODO sections", () => {
    const tasks = [task({ id: "t_20260701_001", section: "DOING" })];
    expect(pickNextTodoTask(tasks, new Map())).toBeNull();
  });
  it("skips tasks with existing runs", () => {
    const tasks = [task({ id: "t_20260701_001" })];
    const runCountById = new Map([["t_20260701_001", 1]]);
    expect(pickNextTodoTask(tasks, runCountById)).toBeNull();
  });
  it("skips tasks with intake in progress", () => {
    const tasks = [
      task({ id: "t_20260701_001", intakeStatus: "planning" }),
      task({ id: "t_20260701_002", intakeStatus: "awaiting-approval" }),
    ];
    expect(pickNextTodoTask(tasks, new Map())).toBeNull();
  });
  it("allows absent or 'none' intake status", () => {
    const tasks = [task({ id: "t_20260701_001", intakeStatus: undefined })];
    expect(pickNextTodoTask(tasks, new Map())?.id).toBe("t_20260701_001");
  });
});

describe("autoQueueTick", () => {
  it("disabled: never spawns", async () => {
    writeAutoQueueConfig({ enabled: false });
    listTasksMock.mockReturnValue([task({ id: "t_20260701_001" })]);
    await autoQueueTick();
    expect(spawnMock).not.toHaveBeenCalled();
    // Config check short-circuits before touching tasks at all.
    expect(listTasksMock).not.toHaveBeenCalled();
  });

  it("enabled, 0 running, two TODO tasks: spawns exactly the oldest", async () => {
    writeAutoQueueConfig({ enabled: true, maxConcurrent: 1 });
    const older = task({ id: "t_20260701_001" });
    const newer = task({ id: "t_20260702_001" });
    listTasksMock.mockReturnValue([newer, older]);
    readMetaMock.mockImplementation(() => meta([]));
    await autoQueueTick();
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(spawnMock.mock.calls[0][0].id).toBe("t_20260701_001");
  });

  it("enabled, maxConcurrent 1, 1 running coordinator: no spawn", async () => {
    writeAutoQueueConfig({ enabled: true, maxConcurrent: 1 });
    const running = task({ id: "t_20260701_001", section: "DOING" });
    const todo = task({ id: "t_20260702_001" });
    listTasksMock.mockReturnValue([running, todo]);
    readMetaMock.mockImplementation((dir: string) =>
      dir.includes(running.id) ? meta([run({ status: "running" })]) : meta([]),
    );
    await autoQueueTick();
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("also counts 'queued' coordinator runs against the cap", async () => {
    writeAutoQueueConfig({ enabled: true, maxConcurrent: 1 });
    const queued = task({ id: "t_20260701_001", section: "DOING" });
    const todo = task({ id: "t_20260702_001" });
    listTasksMock.mockReturnValue([queued, todo]);
    readMetaMock.mockImplementation((dir: string) =>
      dir.includes(queued.id) ? meta([run({ status: "queued" })]) : meta([]),
    );
    await autoQueueTick();
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("task with existing runs is skipped even if section is TODO", async () => {
    writeAutoQueueConfig({ enabled: true, maxConcurrent: 1 });
    const hasRuns = task({ id: "t_20260701_001" }); // TODO but already has a failed run
    const clean = task({ id: "t_20260702_001" });
    listTasksMock.mockReturnValue([hasRuns, clean]);
    readMetaMock.mockImplementation((dir: string) =>
      dir.includes(hasRuns.id) ? meta([run({ status: "failed" })]) : meta([]),
    );
    await autoQueueTick();
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(spawnMock.mock.calls[0][0].id).toBe("t_20260702_001");
  });

  it("task with intake in progress is skipped, not re-dispatched", async () => {
    writeAutoQueueConfig({ enabled: true, maxConcurrent: 1 });
    const planning = task({ id: "t_20260701_001", intakeStatus: "awaiting-approval" });
    listTasksMock.mockReturnValue([planning]);
    readMetaMock.mockImplementation(() => meta([]));
    await autoQueueTick();
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("spawns at most once per tick even with multiple eligible tasks", async () => {
    writeAutoQueueConfig({ enabled: true, maxConcurrent: 5 });
    const a = task({ id: "t_20260701_001" });
    const b = task({ id: "t_20260701_002" });
    listTasksMock.mockReturnValue([a, b]);
    readMetaMock.mockImplementation(() => meta([]));
    await autoQueueTick();
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });
});
