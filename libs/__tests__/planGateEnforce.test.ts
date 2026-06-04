import { describe, it, expect } from "vitest";
import { evaluatePlanGate } from "../planGate";

// Mirrors the gateApplies computation the agents route performs.
function gateApplies(cfgOperatorEnabled: boolean, actorKind: "operator" | "guest"): boolean {
  return cfgOperatorEnabled || actorKind === "guest";
}

describe("agents-route gate decision", () => {
  it("guest mutating spawn on an unplanned task is blocked and kicks planning", () => {
    const applies = gateApplies(false, "guest"); // operator gate OFF, but guest always on
    const d = evaluatePlanGate({ role: "coder", intakeStatus: "none", gateApplies: applies });
    expect(applies).toBe(true);
    expect(d.allowed).toBe(false);
    expect(d.kickPlanning).toBe(true);
  });

  it("operator mutating spawn passes when gate is off", () => {
    const applies = gateApplies(false, "operator");
    const d = evaluatePlanGate({ role: "coder", intakeStatus: "none", gateApplies: applies });
    expect(d.allowed).toBe(true);
  });

  it("planner passes regardless (so the gate can produce a plan)", () => {
    const d = evaluatePlanGate({ role: "planner", intakeStatus: "planning", gateApplies: true });
    expect(d.allowed).toBe(true);
  });

  it("approved task lets a mutating role through", () => {
    const d = evaluatePlanGate({ role: "coder", intakeStatus: "approved", gateApplies: true });
    expect(d.allowed).toBe(true);
  });
});
