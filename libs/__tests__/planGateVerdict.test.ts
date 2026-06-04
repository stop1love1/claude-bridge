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

  it("fails open to clear when nothing is parseable", () => {
    const r = deriveGateVerdict({ intakeJson: null, planMd: null });
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
