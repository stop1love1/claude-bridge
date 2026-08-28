import { describe, it, expect } from "vitest";
import { semanticVerifierEnabled, resolvePanelSize, resolveCriticPanelSize } from "../apps";

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
    expect(resolvePanelSize(app({}), 3)).toBe(3);
  });
  it("clamps to 1..the judges the gate can field", () => {
    expect(resolvePanelSize(app({ verifierPanel: 0 }), 3)).toBe(1);
    expect(resolvePanelSize(app({ verifierPanel: 9 }), 3)).toBe(3);
    expect(resolvePanelSize(app({ verifierPanel: 2 }), 3)).toBe(2);
  });
  it("never returns more judges than the gate can field", () => {
    for (const available of [1, 2, 3]) {
      for (const configured of [1, 2, 3, 4, 5, 9, 100]) {
        expect(
          resolvePanelSize(app({ verifierPanel: configured }), available),
        ).toBeLessThanOrEqual(available);
      }
    }
    expect(resolvePanelSize(app({ verifierPanel: 5 }), 2)).toBe(2);
    expect(resolvePanelSize(app({ verifierPanel: 5 }), 1)).toBe(1);
  });
  it("caps the unset default at the judges available", () => {
    expect(resolvePanelSize(app({}), 2)).toBe(2);
    expect(resolvePanelSize(app({}), 1)).toBe(1);
  });
  it("floors at one judge even when the gate reports none", () => {
    expect(resolvePanelSize(app({}), 0)).toBe(1);
    expect(resolvePanelSize(app({ verifierPanel: 4 }), 0)).toBe(1);
  });
  it("never resolves to a non-finite panel, whatever the gate reports", () => {
    for (const available of [Number.NaN, Number.POSITIVE_INFINITY, -1]) {
      const n = resolvePanelSize(app({ verifierPanel: 3 }), available);
      expect(Number.isInteger(n)).toBe(true);
      expect(n).toBeGreaterThanOrEqual(1);
    }
    expect(resolvePanelSize(app({ verifierPanel: 3 }), Number.NaN)).toBe(1);
    expect(resolveCriticPanelSize(app({}), Number.NaN)).toBe(1);
  });
});

describe("resolveCriticPanelSize", () => {
  it("defaults to 3 and clamps to 1..the judges the gate can field", () => {
    expect(resolveCriticPanelSize(app({}), 3)).toBe(3);
    expect(resolveCriticPanelSize(app({ criticPanel: 0 }), 3)).toBe(1);
    expect(resolveCriticPanelSize(app({ criticPanel: 9 }), 3)).toBe(3);
    expect(resolveCriticPanelSize(app({ criticPanel: 4 }), 3)).toBe(3);
    expect(resolveCriticPanelSize(app({ criticPanel: 2 }), 3)).toBe(2);
  });
  it("never returns more judges than the gate can field", () => {
    for (const available of [1, 2, 3]) {
      for (const configured of [1, 2, 3, 4, 5, 9, 100]) {
        expect(
          resolveCriticPanelSize(app({ criticPanel: configured }), available),
        ).toBeLessThanOrEqual(available);
      }
    }
    expect(resolveCriticPanelSize(app({}), 2)).toBe(2);
  });
});
