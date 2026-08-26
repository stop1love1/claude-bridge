import { expect, it } from "vitest";
import { isBackwardStatusTransition } from "../runStatus";

it("treats terminal -> running as backward", () => {
  for (const from of ["done", "failed", "cancelled", "stale"] as const) {
    expect(isBackwardStatusTransition(from, "running")).toBe(true);
    expect(isBackwardStatusTransition(from, "queued")).toBe(true);
  }
});

it("allows forward transitions", () => {
  expect(isBackwardStatusTransition("queued", "running")).toBe(false);
  expect(isBackwardStatusTransition("running", "done")).toBe(false);
});
