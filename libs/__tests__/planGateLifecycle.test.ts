import { describe, it, expect } from "vitest";
import { computeNextIntakeStatus } from "../planGateLifecycle";
import { deriveGateVerdict } from "../planGate";

describe("computeNextIntakeStatus", () => {
  it("auto-approves a clear plan when the submitter can self-approve", () => {
    expect(computeNextIntakeStatus({ verdict: "clear", submitterCanApprove: true })).toBe("approved");
  });
  it("awaits approval for a clear plan when submitter cannot self-approve (guest w/o grant)", () => {
    expect(computeNextIntakeStatus({ verdict: "clear", submitterCanApprove: false })).toBe("awaiting-approval");
  });
  it("always awaits approval on needs-decision", () => {
    expect(computeNextIntakeStatus({ verdict: "needs-decision", submitterCanApprove: true })).toBe("awaiting-approval");
    expect(computeNextIntakeStatus({ verdict: "needs-decision", submitterCanApprove: false })).toBe("awaiting-approval");
  });
  it("does not auto-approve an operator task when the planner wrote nothing (unknown verdict)", () => {
    expect(computeNextIntakeStatus({ verdict: "unknown", submitterCanApprove: true })).toBe("awaiting-approval");
    expect(computeNextIntakeStatus({ verdict: "unknown", submitterCanApprove: false })).toBe("awaiting-approval");
  });
  it("never auto-approves when the planner's verdict contradicts its own question list", () => {
    const derived = deriveGateVerdict({
      intakeJson: { verdict: "needs-decision", questions: [] },
      planMd: "# Plan\n\nProceed.",
    });
    expect(computeNextIntakeStatus({ verdict: derived.verdict, submitterCanApprove: true })).toBe(
      "awaiting-approval",
    );
  });
});
