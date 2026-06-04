import { describe, it, expect } from "vitest";
import { SEMANTIC_LENSES } from "../semanticVerifier";

describe("SEMANTIC_LENSES", () => {
  it("defines exactly the three v1 lenses with nudges", () => {
    expect(SEMANTIC_LENSES.map((l) => l.key)).toEqual(["correctness", "edge-cases", "regression"]);
    for (const l of SEMANTIC_LENSES) expect(l.nudge.length).toBeGreaterThan(0);
  });
});
