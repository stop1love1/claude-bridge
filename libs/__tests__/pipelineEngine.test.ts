import { describe, expect, it } from "vitest";
import { composeStagePrompt } from "../pipelineEngine";
import type { PipelineStageSnapshot } from "../meta";

const STAGES: PipelineStageSnapshot[] = [
  { name: "Code", role: "coder", prompt: "implement the feature", verify: true },
  { name: "Test", role: "tester", prompt: "write and run tests", verify: true },
  { name: "Review", role: "reviewer", prompt: "review the change", verify: false },
];

describe("composeStagePrompt", () => {
  it("includes the stage position, role, the stage's own prompt, and (none yet) at stage 0", () => {
    const out = composeStagePrompt("Ship feature", STAGES.length, STAGES[0], 0, []);
    expect(out).toContain("Ship feature");
    expect(out).toContain("stage **1 of 3**");
    expect(out).toContain("Code");
    expect(out).toContain("`coder`");
    expect(out).toContain("(none yet)");
    expect(out).toContain("implement the feature");
  });

  it("lists completed stages as handoff context for a later stage", () => {
    const out = composeStagePrompt("Ship feature", STAGES.length, STAGES[2], 2, ["Code", "Test"]);
    expect(out).toContain("stage **3 of 3**");
    expect(out).toContain("Code → Test");
    expect(out).toContain("review the change");
    expect(out.toLowerCase()).toContain("do not redo");
  });
});
