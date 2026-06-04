import { describe, it, expect } from "vitest";
import {
  isMutatingRole,
  canApprove,
  evaluatePlanGate,
  defaultIntake,
} from "../planGate";

describe("isMutatingRole", () => {
  it("treats coder/fixer (and suffixed variants) as mutating", () => {
    expect(isMutatingRole("coder")).toBe(true);
    expect(isMutatingRole("fixer")).toBe(true);
    expect(isMutatingRole("coder-phase24")).toBe(true);
    expect(isMutatingRole("fixer-cashier")).toBe(true);
  });
  it("treats analysis roles (and suffixed variants) as non-mutating", () => {
    for (const r of ["planner", "reviewer", "ui-tester", "semantic-verifier", "style-critic", "devops"]) {
      expect(isMutatingRole(r)).toBe(false);
    }
    expect(isMutatingRole("planner-api")).toBe(false);
    expect(isMutatingRole("reviewer-2")).toBe(false);
  });
});

describe("canApprove", () => {
  it("operator can always approve", () => {
    expect(canApprove({ kind: "operator" })).toBe(true);
  });
  it("guest can approve only with the approvePlan grant", () => {
    expect(canApprove({ kind: "guest", grants: { approvePlan: true } })).toBe(true);
    expect(canApprove({ kind: "guest", grants: { approvePlan: false } })).toBe(false);
    expect(canApprove({ kind: "guest", grants: {} })).toBe(false);
  });
});

describe("evaluatePlanGate", () => {
  const mutating = "coder";
  const safe = "planner";
  it("allows everything when the gate does not apply", () => {
    const d = evaluatePlanGate({ role: mutating, intakeStatus: "none", gateApplies: false });
    expect(d.allowed).toBe(true);
    expect(d.kickPlanning).toBe(false);
  });
  it("always allows non-mutating roles even under the gate", () => {
    const d = evaluatePlanGate({ role: safe, intakeStatus: "planning", gateApplies: true });
    expect(d.allowed).toBe(true);
  });
  it("allows mutating roles once approved", () => {
    const d = evaluatePlanGate({ role: mutating, intakeStatus: "approved", gateApplies: true });
    expect(d.allowed).toBe(true);
  });
  it("blocks mutating roles before approval and kicks planning when none yet", () => {
    const none = evaluatePlanGate({ role: mutating, intakeStatus: "none", gateApplies: true });
    expect(none.allowed).toBe(false);
    expect(none.kickPlanning).toBe(true);
    const planning = evaluatePlanGate({ role: mutating, intakeStatus: "planning", gateApplies: true });
    expect(planning.allowed).toBe(false);
    expect(planning.kickPlanning).toBe(false);
    const awaiting = evaluatePlanGate({ role: mutating, intakeStatus: "awaiting-approval", gateApplies: true });
    expect(awaiting.allowed).toBe(false);
    expect(awaiting.kickPlanning).toBe(false);
  });
});

describe("defaultIntake", () => {
  it("starts in none with empty collections", () => {
    const i = defaultIntake();
    expect(i.status).toBe("none");
    expect(i.questions).toEqual([]);
    expect(i.answers).toEqual([]);
    expect(i.rounds).toBe(0);
  });
});
