import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMeta, readMeta } from "../meta";

describe("readMeta shape validation", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "meta-shape-"));
  });

  afterEach(() => {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { }
  });

  it("returns null for structurally invalid meta rather than throwing later", () => {
    const dir = join(tmp, "t_bad_missing_runs");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "meta.json"), JSON.stringify({ taskTitle: "x" }));
    expect(readMeta(dir)).toBeNull();
  });

  it("returns null when runs is present but not an array", () => {
    const dir = join(tmp, "t_bad_runs_type");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "meta.json"),
      JSON.stringify({
        taskId: "t_x",
        taskTitle: "x",
        taskBody: "",
        taskStatus: "todo",
        taskSection: "TODO",
        taskChecked: false,
        createdAt: "2026-01-01T00:00:00Z",
        runs: "not-an-array",
      }),
    );
    expect(readMeta(dir)).toBeNull();
  });

  it("returns null when createdAt is missing or not a string", () => {
    const dir = join(tmp, "t_bad_created_at");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "meta.json"),
      JSON.stringify({
        taskId: "t_x",
        taskTitle: "x",
        taskBody: "",
        taskStatus: "todo",
        taskSection: "TODO",
        taskChecked: false,
        createdAt: 12345,
        runs: [],
      }),
    );
    expect(readMeta(dir)).toBeNull();
  });

  it("returns null when taskSection is not a known section", () => {
    const dir = join(tmp, "t_bad_section");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "meta.json"),
      JSON.stringify({
        taskId: "t_x",
        taskTitle: "x",
        taskBody: "",
        taskStatus: "todo",
        taskSection: "SOMEWHERE",
        taskChecked: false,
        createdAt: "2026-01-01T00:00:00Z",
        runs: [],
      }),
    );
    expect(readMeta(dir)).toBeNull();
  });

  it("accepts a well-formed meta written by createMeta", () => {
    const dir = join(tmp, "t_good");
    createMeta(dir, {
      taskId: "t_good",
      taskTitle: "good",
      taskBody: "",
      taskStatus: "todo",
      taskSection: "TODO",
      taskChecked: false,
      createdAt: new Date().toISOString(),
    });
    expect(readMeta(dir)).not.toBeNull();
  });

  // Model pinning added `Meta.taskModel` and `Run.model`. Both are optional,
  // so a meta.json written before they existed has to keep reading — and one
  // written with them has to survive the round trip, or a retry could not
  // re-pin the model its run was spawned with.
  it("reads a meta that predates taskModel / run.model", () => {
    const dir = join(tmp, "t_pre_model");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "meta.json"),
      JSON.stringify({
        taskId: "t_pre_model",
        taskTitle: "old",
        taskBody: "",
        taskStatus: "todo",
        taskSection: "TODO",
        taskChecked: false,
        createdAt: "2026-01-01T00:00:00Z",
        runs: [
          {
            sessionId: "s1",
            role: "coder",
            repo: "app",
            status: "done",
            startedAt: null,
            endedAt: null,
          },
        ],
      }),
    );
    const meta = readMeta(dir);
    expect(meta).not.toBeNull();
    expect(meta?.taskModel ?? null).toBeNull();
    expect(meta?.runs[0].model ?? null).toBeNull();
  });

  it("round-trips taskModel and run.model", async () => {
    const { appendRun, updateRun } = await import("../meta");
    const dir = join(tmp, "t_with_model");
    createMeta(dir, {
      taskId: "t_with_model",
      taskTitle: "pinned",
      taskBody: "",
      taskStatus: "todo",
      taskSection: "TODO",
      taskChecked: false,
      taskModel: "claude-opus-5",
      createdAt: new Date().toISOString(),
    });
    await appendRun(dir, {
      sessionId: "s1",
      role: "coder",
      repo: "app",
      status: "queued",
      startedAt: null,
      endedAt: null,
      model: "claude-opus-5",
    });
    expect(readMeta(dir)?.taskModel).toBe("claude-opus-5");
    expect(readMeta(dir)?.runs[0].model).toBe("claude-opus-5");

    await updateRun(dir, "s1", { model: null });
    expect(readMeta(dir)?.runs[0].model).toBeNull();
  });
});

describe("listTasks isolates a corrupt sibling task", () => {
  const TMP_SESSIONS = vi.hoisted(() => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { mkdtempSync } = require("node:fs") as typeof import("node:fs");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { tmpdir } = require("node:os") as typeof import("node:os");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { join } = require("node:path") as typeof import("node:path");
    return mkdtempSync(join(tmpdir(), "bridge-list-tasks-"));
  });

  vi.mock("../paths", async () => {
    const actual = await vi.importActual<typeof import("../paths")>("../paths");
    return { ...actual, SESSIONS_DIR: TMP_SESSIONS };
  });

  afterEach(() => {
    try { rmSync(TMP_SESSIONS, { recursive: true, force: true }); } catch { }
    mkdirSync(TMP_SESSIONS, { recursive: true });
  });

  it("keeps good tasks visible when a sibling meta.json is corrupt", async () => {
    const { createMeta } = await import("../meta");
    const { listTasks } = await import("../tasksStore");

    createMeta(join(TMP_SESSIONS, "t_20260827_101"), {
      taskId: "t_20260827_101",
      taskTitle: "good",
      taskBody: "",
      taskStatus: "todo",
      taskSection: "TODO",
      taskChecked: false,
      createdAt: "2026-08-27T10:00:00Z",
    });

    const badDir = join(TMP_SESSIONS, "t_20260827_102");
    mkdirSync(badDir, { recursive: true });
    writeFileSync(join(badDir, "meta.json"), JSON.stringify({ runs: "not-an-array" }));

    const tasks = listTasks();
    expect(tasks.map((t) => t.id)).toContain("t_20260827_101");
    expect(tasks.map((t) => t.id)).not.toContain("t_20260827_102");
  });
});
