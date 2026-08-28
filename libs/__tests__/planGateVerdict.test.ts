import { describe, it, expect } from "vitest";
import { deriveGateVerdict } from "../planGate";

describe("deriveGateVerdict", () => {
  it("uses intake.json verdict when present and valid", () => {
    const r = deriveGateVerdict({
      intakeJson: {
        verdict: "needs-decision",
        summary: "Build a CSV export",
        questions: [{ id: "q1", text: "Which columns?", options: ["all", "subset"] }],
      },
      planMd: "# Plan\n## Questions for the user\n- ignored, json wins",
    });
    expect(r.verdict).toBe("needs-decision");
    expect(r.summary).toBe("Build a CSV export");
    expect(r.questions).toHaveLength(1);
    expect(r.questions[0].id).toBe("q1");
  });

  it("falls back to parsing plan.md questions when json is absent", () => {
    const r = deriveGateVerdict({
      intakeJson: null,
      planMd: [
        "# Plan",
        "## Questions for the user",
        "- Should deletes be soft or hard?",
        "- Which timezone for timestamps?",
        "## Out of scope",
        "- migrations",
      ].join("\n"),
    });
    expect(r.verdict).toBe("needs-decision");
    expect(r.questions.map((q) => q.text)).toEqual([
      "Should deletes be soft or hard?",
      "Which timezone for timestamps?",
    ]);
  });

  it("is clear when plan.md questions section is empty or (none)", () => {
    const r = deriveGateVerdict({
      intakeJson: null,
      planMd: "# Plan\n## Questions for the user\n(none)\n## Out of scope\n- x",
    });
    expect(r.verdict).toBe("clear");
    expect(r.questions).toEqual([]);
  });

  it("returns unknown (not clear) when no artifact was produced at all", () => {
    const r = deriveGateVerdict({ intakeJson: null, planMd: "" });
    expect(r.verdict).toBe("unknown");
  });

  it("still returns clear when the planner explicitly recorded zero questions", () => {
    const r = deriveGateVerdict({
      intakeJson: { questions: [] },
      planMd: "# Plan\n\nProceed.",
    });
    expect(r.verdict).toBe("clear");
  });

  it("returns unknown when intake.json is present but schema-invalid and plan.md is empty", () => {
    const r = deriveGateVerdict({ intakeJson: {}, planMd: "" });
    expect(r.verdict).toBe("unknown");
  });

  it("keeps a recognized verdict even when plan.md is empty", () => {
    const r = deriveGateVerdict({
      intakeJson: { verdict: "clear", questions: [] },
      planMd: "",
    });
    expect(r.verdict).toBe("clear");
  });

  it("ignores an invalid json verdict and falls back", () => {
    const r = deriveGateVerdict({
      intakeJson: { verdict: "garbage", questions: [] },
      planMd: "## Questions for the user\n- real question?",
    });
    expect(r.verdict).toBe("needs-decision");
    expect(r.questions[0].text).toBe("real question?");
  });
});

describe("deriveGateVerdict — planner verdict contradicting its own question list", () => {
  it("does not coerce needs-decision with zero questions to clear", () => {
    const r = deriveGateVerdict({
      intakeJson: { verdict: "needs-decision", summary: "ship the export", questions: [] },
      planMd: "# Plan\n\nProceed.",
    });
    expect(r.verdict).not.toBe("clear");
  });

  it("records the contradiction as unknown so the gate cannot auto-approve", () => {
    const r = deriveGateVerdict({
      intakeJson: { verdict: "needs-decision", questions: [] },
      planMd: "# Plan\n\nProceed.",
    });
    expect(r.verdict).toBe("unknown");
    expect(r.questions).toEqual([]);
  });

  it("names the contradiction in the operator-visible summary", () => {
    const r = deriveGateVerdict({
      intakeJson: { verdict: "needs-decision", questions: [] },
      planMd: "# Plan",
    });
    expect(r.summary).toContain("needs-decision");
    expect(r.summary).toContain("no questions");
  });

  it("keeps the planner's own summary alongside the contradiction note", () => {
    const r = deriveGateVerdict({
      intakeJson: { verdict: "needs-decision", summary: "ship the export", questions: [] },
      planMd: "# Plan",
    });
    expect(r.summary).toContain("ship the export");
    expect(r.summary).toContain("needs-decision");
  });

  it("recovers the questions from plan.md instead of discarding the verdict", () => {
    const r = deriveGateVerdict({
      intakeJson: { verdict: "needs-decision", summary: "ship the export", questions: [] },
      planMd: "# Plan\n## Questions for the user\n- Which columns?\n",
    });
    expect(r.verdict).toBe("needs-decision");
    expect(r.questions.map((q) => q.text)).toEqual(["Which columns?"]);
    expect(r.summary).toBe("ship the export");
  });

  it("treats a plan.md questions section of (none) as nothing to recover", () => {
    const r = deriveGateVerdict({
      intakeJson: { verdict: "needs-decision", questions: [] },
      planMd: "# Plan\n## Questions for the user\n(none)\n",
    });
    expect(r.verdict).toBe("unknown");
  });

  it("leaves a needs-decision that does list its questions untouched", () => {
    const r = deriveGateVerdict({
      intakeJson: {
        verdict: "needs-decision",
        summary: "ship the export",
        questions: [{ id: "q1", text: "Which columns?" }],
      },
      planMd: "",
    });
    expect(r.verdict).toBe("needs-decision");
    expect(r.summary).toBe("ship the export");
    expect(r.questions).toHaveLength(1);
  });
});
