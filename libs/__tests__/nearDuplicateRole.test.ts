import { describe, it, expect } from "vitest";
import {
  findNearDuplicateRole,
  nearDuplicateStems,
} from "../nearDuplicateRole";
import type { Run } from "../meta";

const PARENT = "11111111-2222-3333-4444-555555555555";
const SID_A = "aaaaaaaa-2222-3333-4444-555555555555";
const SID_B = "bbbbbbbb-2222-3333-4444-555555555555";

function run(overrides: Partial<Run>): Run {
  return {
    sessionId: SID_A,
    role: "fixer",
    repo: "edusoft-lms",
    status: "done",
    startedAt: "2026-05-14T10:00:00Z",
    endedAt: "2026-05-14T10:05:00Z",
    parentSessionId: PARENT,
    ...overrides,
  };
}

describe("nearDuplicateStems", () => {
  it("strips a trailing dash-token suffix", () => {
    expect(nearDuplicateStems("fixer-cashier")).toContain("fixer");
    expect(nearDuplicateStems("api-builder-handler")).toContain("api-builder");
  });

  it("strips trailing digits", () => {
    expect(nearDuplicateStems("fixer2")).toContain("fixer");
    expect(nearDuplicateStems("coder-v2")).toEqual(
      expect.arrayContaining(["coder", "coder-v"]),
    );
  });

  it("returns empty for plain single-word roles", () => {
    expect(nearDuplicateStems("fixer")).toEqual([]);
    expect(nearDuplicateStems("coordinator")).toEqual([]);
  });
});

describe("findNearDuplicateRole", () => {
  it("flags `fixer-cashier` as near-duplicate of an existing `fixer`", () => {
    const result = findNearDuplicateRole({
      runs: [run({ role: "fixer", status: "done" })],
      parentSessionId: PARENT,
      repo: "edusoft-lms",
      role: "fixer-cashier",
    });
    expect(result).not.toBeNull();
    expect(result?.existing.role).toBe("fixer");
    expect(result?.newRole).toBe("fixer-cashier");
  });

  it("returns null when no existing role matches the stripped stem", () => {
    const result = findNearDuplicateRole({
      runs: [run({ role: "reviewer" })],
      parentSessionId: PARENT,
      repo: "edusoft-lms",
      role: "fixer-cashier",
    });
    expect(result).toBeNull();
  });

  it("returns null for fresh-spawn roles with no suffix to strip", () => {
    const result = findNearDuplicateRole({
      runs: [run({ role: "fixer" })],
      parentSessionId: PARENT,
      repo: "edusoft-lms",
      role: "reviewer",
    });
    expect(result).toBeNull();
  });

  it("ignores existing runs whose status is queued/running (only terminal candidates)", () => {
    const result = findNearDuplicateRole({
      runs: [run({ role: "fixer", status: "running" })],
      parentSessionId: PARENT,
      repo: "edusoft-lms",
      role: "fixer-cashier",
    });
    expect(result).toBeNull();
  });

  it("ignores existing retry-suffix rows so `-vretry` siblings don't trigger the warning", () => {
    const result = findNearDuplicateRole({
      runs: [run({ role: "fixer-vretry", status: "done" })],
      parentSessionId: PARENT,
      repo: "edusoft-lms",
      role: "fixer-vretry-extra",
    });
    expect(result).toBeNull();
  });

  it("doesn't flag the new role when it itself is a sanctioned retry suffix", () => {
    const result = findNearDuplicateRole({
      runs: [run({ role: "fixer", status: "done" })],
      parentSessionId: PARENT,
      repo: "edusoft-lms",
      role: "fixer-cretry",
    });
    expect(result).toBeNull();
  });

  it("requires the same parentSessionId — siblings under a different coordinator don't count", () => {
    const result = findNearDuplicateRole({
      runs: [run({ role: "fixer", parentSessionId: "other-coord" })],
      parentSessionId: PARENT,
      repo: "edusoft-lms",
      role: "fixer-cashier",
    });
    expect(result).toBeNull();
  });

  it("requires the same repo", () => {
    const result = findNearDuplicateRole({
      runs: [run({ role: "fixer", repo: "edusoft-lms-api" })],
      parentSessionId: PARENT,
      repo: "edusoft-lms",
      role: "fixer-cashier",
    });
    expect(result).toBeNull();
  });

  it("picks the earliest-completed candidate when multiple match", () => {
    const result = findNearDuplicateRole({
      runs: [
        run({ sessionId: SID_A, role: "fixer", endedAt: "2026-05-14T10:05:00Z" }),
        run({ sessionId: SID_B, role: "fixer", endedAt: "2026-05-14T10:01:00Z" }),
      ],
      parentSessionId: PARENT,
      repo: "edusoft-lms",
      role: "fixer-cashier",
    });
    expect(result?.existing.sessionId).toBe(SID_B); // earlier endedAt
  });

  it("flags `coder-v2` as near-duplicate of an existing `coder`", () => {
    const result = findNearDuplicateRole({
      runs: [run({ role: "coder" })],
      parentSessionId: PARENT,
      repo: "edusoft-lms",
      role: "coder-v2",
    });
    expect(result?.existing.role).toBe("coder");
  });

  it("respects allowDuplicate semantics by being a no-op when bypassed by caller (caller must skip the call)", () => {
    // Caller-side: when `allowDuplicate: true` is set, the route is
    // expected to NOT call findNearDuplicateRole at all. This test
    // documents the contract: the function itself does not check
    // allowDuplicate (route does), but it's harmless to call.
    const result = findNearDuplicateRole({
      runs: [run({ role: "fixer" })],
      parentSessionId: PARENT,
      repo: "edusoft-lms",
      role: "fixer-cashier",
    });
    // Function returns the match either way — gating is the route's job.
    expect(result).not.toBeNull();
  });
});
