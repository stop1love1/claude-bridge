import { describe, it, expect } from "vitest";
import { parseTasks, serializeTasks, generateTaskId } from "../tasks";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const fixture = readFileSync(join(__dirname, "fixtures/tasks-basic.md"), "utf8");

describe("parseTasks", () => {
  it("extracts tasks with id, title, date, status, body", () => {
    const tasks = parseTasks(fixture);
    expect(tasks).toHaveLength(3);

    const t1 = tasks.find((t) => t.id === "t_20260424_001")!;
    expect(t1.status).toBe("todo");
    expect(t1.section).toBe("TODO");
    expect(t1.date).toBe("2026-04-24");
    expect(t1.title).toBe("Add /users/me endpoint");
    expect(t1.body).toContain("Contract: `contracts/users-me.md`");
    expect(t1.body).toContain("Notes: needs email + roles");

    const t2 = tasks.find((t) => t.id === "t_20260423_002")!;
    expect(t2.status).toBe("doing");

    const t3 = tasks.find((t) => t.id === "t_20260422_001")!;
    expect(t3.status).toBe("done");
    expect(t3.checked).toBe(true);
  });
});

describe("serializeTasks", () => {
  it("round-trips fixture → parse → serialize → parse", () => {
    const tasks = parseTasks(fixture);
    const md = serializeTasks(fixture, tasks);
    const reparsed = parseTasks(md);
    expect(reparsed).toEqual(tasks);
  });

  it("moves a task to a new section when status changes", () => {
    const tasks = parseTasks(fixture);
    const t1 = tasks.find((t) => t.id === "t_20260424_001")!;
    t1.status = "doing";
    t1.section = "DOING";
    const md = serializeTasks(fixture, tasks);
    const reparsed = parseTasks(md);
    const moved = reparsed.find((t) => t.id === "t_20260424_001")!;
    expect(moved.section).toBe("DOING");
  });
});

describe("generateTaskId", () => {
  it("returns t_YYYYMMDD_NNN incrementing from existing IDs for the same day", () => {
    const existing = ["t_20260424_001", "t_20260424_002", "t_20260423_005"];
    expect(generateTaskId(new Date("2026-04-24T10:00:00Z"), existing)).toBe("t_20260424_003");
    expect(generateTaskId(new Date("2026-04-25T10:00:00Z"), existing)).toBe("t_20260425_001");
  });
});
