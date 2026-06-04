import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMeta, readMeta, writeMeta, readIntake, setIntake, type Meta } from "../meta";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "intake-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function header(): Omit<Meta, "runs"> {
  return {
    taskId: "t_20260604_001",
    taskTitle: "x",
    taskBody: "y",
    taskStatus: "doing",
    taskSection: "DOING",
    taskChecked: false,
    createdAt: new Date().toISOString(),
  };
}

describe("intake meta helpers", () => {
  it("legacy meta with no intake reads as null (migration-safe)", () => {
    createMeta(dir, header());
    expect(readIntake(dir)).toBeNull();
  });

  it("setIntake creates an intake record from defaults and patches it", async () => {
    createMeta(dir, header());
    const rec = await setIntake(dir, { status: "planning" });
    expect(rec?.status).toBe("planning");
    expect(rec?.rounds).toBe(0); // inherited from defaultIntake
    expect(readIntake(dir)?.status).toBe("planning");
  });

  it("setIntake merges successive patches", async () => {
    createMeta(dir, header());
    await setIntake(dir, { status: "planning" });
    const rec = await setIntake(dir, { status: "approved", verdict: "clear" });
    expect(rec?.status).toBe("approved");
    expect(rec?.verdict).toBe("clear");
  });

  it("setIntake on a missing task returns null", async () => {
    expect(await setIntake(join(dir, "nope"), { status: "planning" })).toBeNull();
  });

  it("round-trips through writeMeta without dropping intake", async () => {
    createMeta(dir, header());
    await setIntake(dir, { status: "awaiting-approval" });
    const meta = readMeta(dir)!;
    writeMeta(dir, meta);
    expect(readIntake(dir)?.status).toBe("awaiting-approval");
  });
});
