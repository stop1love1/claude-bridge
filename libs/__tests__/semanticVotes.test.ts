import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMeta, readMeta, writeMeta, type Meta, type RunSemanticVerifier } from "../meta";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "svotes-")); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function header(): Omit<Meta, "runs"> {
  return {
    taskId: "t_20260604_001", taskTitle: "x", taskBody: "y",
    taskStatus: "doing", taskSection: "DOING", taskChecked: false,
    createdAt: new Date().toISOString(),
  };
}

describe("RunSemanticVerifier votes/panelSize", () => {
  it("round-trips votes + panelSize through meta", () => {
    createMeta(dir, header());
    const meta = readMeta(dir)!;
    const sv: RunSemanticVerifier = {
      verdict: "broken", reason: "r", concerns: ["c"], durationMs: 1,
      panelSize: 3,
      votes: [
        { lens: "correctness", verdict: "broken", reason: "rc" },
        { lens: "edge-cases", verdict: "broken", reason: "re" },
        { lens: "regression", verdict: "pass", reason: "rr" },
      ],
    };
    meta.runs.push({
      sessionId: "00000000-0000-4000-8000-000000000002",
      role: "coder", repo: "app", status: "done", startedAt: null, endedAt: null,
      semanticVerifier: sv,
    });
    writeMeta(dir, meta);
    const back = readMeta(dir)!.runs[0].semanticVerifier!;
    expect(back.panelSize).toBe(3);
    expect(back.votes?.map((v) => v.lens)).toEqual(["correctness", "edge-cases", "regression"]);
  });
});
