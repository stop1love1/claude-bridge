import { describe, it, expect } from "vitest";
import { computeNextIntakeStatus } from "../planGateLifecycle";

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
    // Audit H5: "unknown" must route to a human regardless of who submitted
    // the task — it is not evidence of a clean, reviewable plan.
    expect(computeNextIntakeStatus({ verdict: "unknown", submitterCanApprove: true })).toBe("awaiting-approval");
    expect(computeNextIntakeStatus({ verdict: "unknown", submitterCanApprove: false })).toBe("awaiting-approval");
  });
});
