import { describe, it, expect } from "vitest";
import { semanticVerifierEnabled, resolvePanelSize } from "../apps";

const app = (quality: unknown) => ({ quality } as Parameters<typeof semanticVerifierEnabled>[0]);

describe("semanticVerifierEnabled (default-on)", () => {
  it("is on when quality.verifier is undefined", () => {
    expect(semanticVerifierEnabled(app({}))).toBe(true);
    expect(semanticVerifierEnabled(app(undefined))).toBe(true);
  });
  it("respects an explicit false", () => {
    expect(semanticVerifierEnabled(app({ verifier: false }))).toBe(false);
  });
  it("is on for explicit true", () => {
    expect(semanticVerifierEnabled(app({ verifier: true }))).toBe(true);
  });
});

describe("resolvePanelSize", () => {
  it("defaults to 3 when unset", () => {
    expect(resolvePanelSize(app({}))).toBe(3);
  });
  it("clamps to 1..5", () => {
    expect(resolvePanelSize(app({ verifierPanel: 0 }))).toBe(1);
    expect(resolvePanelSize(app({ verifierPanel: 9 }))).toBe(5);
    expect(resolvePanelSize(app({ verifierPanel: 2 }))).toBe(2);
  });
});
