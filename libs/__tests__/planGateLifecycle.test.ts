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
});
