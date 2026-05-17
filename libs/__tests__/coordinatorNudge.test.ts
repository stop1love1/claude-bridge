import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  decideNudge,
  isSummaryStale,
  shouldFinalizeDeferredCoordinator,
  shouldMarkCoordinatorSummaryBlocked,
} from "../coordinatorNudge";
import type { Run } from "../meta";

const COORD_SID = "11111111-2222-3333-4444-555555555555";
const CHILD_A_SID = "aaaaaaaa-2222-3333-4444-555555555555";
const CHILD_B_SID = "bbbbbbbb-2222-3333-4444-555555555555";

function coordinator(overrides: Partial<Run> = {}): Run {
  return {
    sessionId: COORD_SID,
    role: "coordinator",
    repo: "claude-bridge",
    status: "done",
    startedAt: "2026-05-14T10:00:00Z",
    endedAt: "2026-05-14T10:00:30Z",
    ...overrides,
  };
}

function child(sid: string, status: Run["status"], overrides: Partial<Run> = {}): Run {
  return {
    sessionId: sid,
    role: "coder",
    repo: "edusoft-lms",
    status,
    startedAt: "2026-05-14T10:01:00Z",
    endedAt: status === "done" || status === "failed" ? "2026-05-14T10:02:00Z" : null,
    parentSessionId: COORD_SID,
    ...overrides,
  };
}

const NEVER_ALIVE = () => false;
const ALWAYS_ALIVE = () => true;

describe("decideNudge", () => {
  it("nudges when all children are terminal and coordinator is idle", () => {
    const decision = decideNudge({
      parentSessionId: COORD_SID,
      runs: [coordinator(), child(CHILD_A_SID, "done"), child(CHILD_B_SID, "failed")],
      isAlive: NEVER_ALIVE,
      lastNudgeAt: null,
      now: 1_000_000,
    });
    expect(decision.kind).toBe("nudge");
    if (decision.kind === "nudge") {
      expect(decision.children).toHaveLength(2);
    }
  });

  it("skips when no coordinator row exists for the given parentSessionId", () => {
    const decision = decideNudge({
      parentSessionId: COORD_SID,
      // No coordinator row in runs[]
      runs: [child(CHILD_A_SID, "done")],
      isAlive: NEVER_ALIVE,
      lastNudgeAt: null,
      now: 1_000_000,
    });
    expect(decision).toEqual({ kind: "skip", reason: "no coordinator row" });
  });

  it("skips when the coordinator has no children yet", () => {
    const decision = decideNudge({
      parentSessionId: COORD_SID,
      runs: [coordinator()],
      isAlive: NEVER_ALIVE,
      lastNudgeAt: null,
      now: 1_000_000,
    });
    expect(decision).toEqual({ kind: "skip", reason: "no children" });
  });

  it("skips when at least one child is still running (covers the retry-spawn race)", () => {
    const decision = decideNudge({
      parentSessionId: COORD_SID,
      runs: [
        coordinator(),
        child(CHILD_A_SID, "done"),
        child(CHILD_B_SID, "running"),
      ],
      isAlive: NEVER_ALIVE,
      lastNudgeAt: null,
      now: 1_000_000,
    });
    expect(decision).toEqual({ kind: "skip", reason: "child still running" });
  });

  it("skips when the coordinator process is still alive (let it discover state itself)", () => {
    const decision = decideNudge({
      parentSessionId: COORD_SID,
      runs: [coordinator(), child(CHILD_A_SID, "done")],
      isAlive: ALWAYS_ALIVE,
      lastNudgeAt: null,
      now: 1_000_000,
    });
    expect(decision).toEqual({ kind: "skip", reason: "coordinator alive" });
  });

  it("skips when a recent nudge was already sent (debounce)", () => {
    const decision = decideNudge({
      parentSessionId: COORD_SID,
      runs: [coordinator(), child(CHILD_A_SID, "done")],
      isAlive: NEVER_ALIVE,
      lastNudgeAt: 999_000,
      now: 1_000_000, // 1s after — well within the 5s debounce
    });
    expect(decision).toEqual({ kind: "skip", reason: "debounced" });
  });

  it("nudges again once the debounce window elapses", () => {
    const decision = decideNudge({
      parentSessionId: COORD_SID,
      runs: [coordinator(), child(CHILD_A_SID, "done")],
      isAlive: NEVER_ALIVE,
      lastNudgeAt: 999_000,
      now: 999_000 + 5_001, // 1ms past the 5s window
    });
    expect(decision.kind).toBe("nudge");
  });

  it("treats `stale` children as terminal", () => {
    const decision = decideNudge({
      parentSessionId: COORD_SID,
      runs: [coordinator(), child(CHILD_A_SID, "stale")],
      isAlive: NEVER_ALIVE,
      lastNudgeAt: null,
      now: 1_000_000,
    });
    expect(decision.kind).toBe("nudge");
  });

  it("ignores children whose parentSessionId points at a different coordinator", () => {
    const decision = decideNudge({
      parentSessionId: COORD_SID,
      runs: [
        coordinator(),
        child(CHILD_A_SID, "done"),
        // This one belongs to some other coordinator — must be ignored.
        child(CHILD_B_SID, "running", { parentSessionId: "other-coord" }),
      ],
      isAlive: NEVER_ALIVE,
      lastNudgeAt: null,
      now: 1_000_000,
    });
    expect(decision.kind).toBe("nudge");
    if (decision.kind === "nudge") {
      expect(decision.children.map((c) => c.sessionId)).toEqual([CHILD_A_SID]);
    }
  });
});

describe("decideNudge — summary-aware branches", () => {
  it("skips when summary.md is already present (avoids burning a turn on a no-op nudge)", () => {
    const decision = decideNudge({
      parentSessionId: COORD_SID,
      runs: [coordinator(), child(CHILD_A_SID, "done")],
      isAlive: NEVER_ALIVE,
      lastNudgeAt: null,
      now: 1_000_000,
      summaryMissing: false,
    });
    expect(decision).toEqual({ kind: "skip", reason: "summary already written" });
  });

  it("nudges when summaryMissing=true and all other conditions met", () => {
    const decision = decideNudge({
      parentSessionId: COORD_SID,
      runs: [coordinator(), child(CHILD_A_SID, "done")],
      isAlive: NEVER_ALIVE,
      lastNudgeAt: null,
      now: 1_000_000,
      summaryMissing: true,
      summaryNudgeAttempts: 0,
    });
    expect(decision.kind).toBe("nudge");
  });

  it("skips after SUMMARY_NUDGE_MAX_ATTEMPTS reached (prevents infinite resume loops)", () => {
    const decision = decideNudge({
      parentSessionId: COORD_SID,
      runs: [coordinator(), child(CHILD_A_SID, "done")],
      isAlive: NEVER_ALIVE,
      lastNudgeAt: null,
      now: 1_000_000,
      summaryMissing: true,
      summaryNudgeAttempts: 3, // == SUMMARY_NUDGE_MAX_ATTEMPTS
    });
    expect(decision).toEqual({
      kind: "skip",
      reason: "summary nudge attempts exhausted",
    });
  });

  it("treats absent summaryMissing as `true` for back-compat with legacy callers", () => {
    // Older tests / callers that don't thread the flag through must
    // keep the original "always try to nudge once conditions are met"
    // behavior so we don't silently regress a working bridge.
    const decision = decideNudge({
      parentSessionId: COORD_SID,
      runs: [coordinator(), child(CHILD_A_SID, "done")],
      isAlive: NEVER_ALIVE,
      lastNudgeAt: null,
      now: 1_000_000,
    });
    expect(decision.kind).toBe("nudge");
  });

  it("nudges when summary is present but STALE (round-2 children finished after round-1 summary)", () => {
    // The bug this guards: coordinator finishes round 1, writes
    // summary.md, exits. User asks for more work via chat, coordinator
    // resumes, spawns round-2 children. They finish — but the old skip
    // ("summary already written") would suppress the nudge and the
    // coordinator stays silent until the user pings manually.
    const decision = decideNudge({
      parentSessionId: COORD_SID,
      runs: [coordinator(), child(CHILD_A_SID, "done")],
      isAlive: NEVER_ALIVE,
      lastNudgeAt: null,
      now: 1_000_000,
      summaryMissing: false,
      summaryStale: true,
      summaryNudgeAttempts: 0,
    });
    expect(decision.kind).toBe("nudge");
  });

  it("still skips when summary is fresh (NOT stale) — round 1 close path", () => {
    // Counterpart to the stale test: when summary covers the latest
    // child exit, no nudge fires. Keeps the round-1 finalize path
    // working and prevents spurious wake-ups.
    const decision = decideNudge({
      parentSessionId: COORD_SID,
      runs: [coordinator(), child(CHILD_A_SID, "done")],
      isAlive: NEVER_ALIVE,
      lastNudgeAt: null,
      now: 1_000_000,
      summaryMissing: false,
      summaryStale: false,
    });
    expect(decision).toEqual({ kind: "skip", reason: "summary already written" });
  });

  it("stale summary still respects the SUMMARY_NUDGE_MAX_ATTEMPTS cap", () => {
    // A coordinator that keeps producing stale summaries would loop
    // forever without this guard. Same cap as the missing-summary case.
    const decision = decideNudge({
      parentSessionId: COORD_SID,
      runs: [coordinator(), child(CHILD_A_SID, "done")],
      isAlive: NEVER_ALIVE,
      lastNudgeAt: null,
      now: 1_000_000,
      summaryMissing: false,
      summaryStale: true,
      summaryNudgeAttempts: 3,
    });
    expect(decision).toEqual({
      kind: "skip",
      reason: "summary nudge attempts exhausted",
    });
  });
});

describe("isSummaryMissing", () => {
  let tempSessionsRoot: string;
  let originalCwd: string;

  beforeEach(() => {
    // `isSummaryMissing` resolves the path through `SESSIONS_DIR`, which
    // is evaluated at module load from `process.cwd()`. Chdir into a
    // fresh temp dir THEN `vi.resetModules()` so the re-import re-runs
    // `paths.ts` against the new cwd. Without the reset the module
    // would stay pinned to the workspace root and the writes below
    // would land in a path the function never looks at.
    originalCwd = process.cwd();
    tempSessionsRoot = mkdtempSync(join(tmpdir(), "bridge-summary-"));
    process.chdir(tempSessionsRoot);
    vi.resetModules();
  });

  afterEach(() => {
    process.chdir(originalCwd);
    vi.resetModules();
    try {
      rmSync(tempSessionsRoot, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  });

  it("returns true when the file is missing", async () => {
    const { isSummaryMissing } = await import("../coordinatorNudge");
    expect(isSummaryMissing("t_99990101_001")).toBe(true);
  });

  it("returns true when the file exists but is empty", async () => {
    const taskId = "t_99990101_002";
    const dir = join(tempSessionsRoot, "sessions", taskId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "summary.md"), "", "utf8");
    const { isSummaryMissing } = await import("../coordinatorNudge");
    expect(isSummaryMissing(taskId)).toBe(true);
  });

  it("returns true when the file contains only whitespace", async () => {
    const taskId = "t_99990101_003";
    const dir = join(tempSessionsRoot, "sessions", taskId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "summary.md"), "   \n\t\n  ", "utf8");
    const { isSummaryMissing } = await import("../coordinatorNudge");
    expect(isSummaryMissing(taskId)).toBe(true);
  });

  it("returns false when the file has real content", async () => {
    const taskId = "t_99990101_004";
    const dir = join(tempSessionsRoot, "sessions", taskId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "summary.md"),
      "READY FOR REVIEW — shipped foo",
      "utf8",
    );
    const { isSummaryMissing } = await import("../coordinatorNudge");
    expect(isSummaryMissing(taskId)).toBe(false);
  });
});

describe("isSummaryStale (round-2 freshness check)", () => {
  let tempSessionsRoot: string;
  let originalCwd: string;

  beforeEach(() => {
    // Same chdir-then-resetModules dance as the `isSummaryMissing`
    // suite — `SESSIONS_DIR` snapshots `process.cwd()` at module load.
    originalCwd = process.cwd();
    tempSessionsRoot = mkdtempSync(join(tmpdir(), "bridge-stale-"));
    process.chdir(tempSessionsRoot);
    vi.resetModules();
  });

  afterEach(() => {
    process.chdir(originalCwd);
    vi.resetModules();
    try {
      rmSync(tempSessionsRoot, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  });

  it("returns false when summary.md doesn't exist (no comparison possible)", async () => {
    const { isSummaryStale } = await import("../coordinatorNudge");
    expect(
      isSummaryStale({
        taskId: "t_99990101_010",
        parentSessionId: COORD_SID,
        runs: [coordinator(), child(CHILD_A_SID, "done")],
      }),
    ).toBe(false);
  });

  it("returns false when no terminal children of this parent exist", async () => {
    const taskId = "t_99990101_011";
    const dir = join(tempSessionsRoot, "sessions", taskId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "summary.md"), "READY FOR REVIEW", "utf8");
    const { isSummaryStale } = await import("../coordinatorNudge");
    expect(
      isSummaryStale({
        taskId,
        parentSessionId: COORD_SID,
        runs: [coordinator(), child(CHILD_A_SID, "running")],
      }),
    ).toBe(false);
  });

  it("returns true when summary mtime is older than the latest child's endedAt", async () => {
    const taskId = "t_99990101_012";
    const dir = join(tempSessionsRoot, "sessions", taskId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "summary.md"), "READY FOR REVIEW — round 1", "utf8");
    const { isSummaryStale } = await import("../coordinatorNudge");
    // Stamp the round-2 child as ending far in the future so the mtime
    // comparison is unambiguous regardless of FS clock skew.
    const futureEnd = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    expect(
      isSummaryStale({
        taskId,
        parentSessionId: COORD_SID,
        runs: [
          coordinator(),
          child(CHILD_A_SID, "done", { endedAt: futureEnd }),
        ],
      }),
    ).toBe(true);
  });

  it("returns false when summary mtime is newer than every child's endedAt", async () => {
    const taskId = "t_99990101_013";
    const dir = join(tempSessionsRoot, "sessions", taskId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "summary.md"), "READY FOR REVIEW — fresh", "utf8");
    const { isSummaryStale } = await import("../coordinatorNudge");
    // Child finished an hour ago; summary was just written.
    const pastEnd = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    expect(
      isSummaryStale({
        taskId,
        parentSessionId: COORD_SID,
        runs: [
          coordinator(),
          child(CHILD_A_SID, "done", { endedAt: pastEnd }),
        ],
      }),
    ).toBe(false);
  });

  it("ignores children that aren't direct descendants of parentSessionId", async () => {
    const taskId = "t_99990101_014";
    const dir = join(tempSessionsRoot, "sessions", taskId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "summary.md"), "READY FOR REVIEW", "utf8");
    const { isSummaryStale } = await import("../coordinatorNudge");
    const futureEnd = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    // Future-ended run belongs to a different parent — must not
    // trigger staleness for COORD_SID.
    expect(
      isSummaryStale({
        taskId,
        parentSessionId: COORD_SID,
        runs: [
          coordinator(),
          child(CHILD_A_SID, "done", {
            parentSessionId: "different-parent",
            endedAt: futureEnd,
          }),
        ],
      }),
    ).toBe(false);
  });
});

describe("shouldFinalizeDeferredCoordinator (2b deferred-DONE finalizer)", () => {
  it("returns true when coordinator is `running`, process gone, all children terminal (deferred-DONE case)", () => {
    expect(
      shouldFinalizeDeferredCoordinator({
        parentSessionId: COORD_SID,
        runs: [
          coordinator({ status: "running", endedAt: null }),
          child(CHILD_A_SID, "done"),
          child(CHILD_B_SID, "failed"),
        ],
        isAlive: NEVER_ALIVE,
      }),
    ).toBe(true);
  });

  it("returns false when coordinator status is already `done` (no deferral happened)", () => {
    expect(
      shouldFinalizeDeferredCoordinator({
        parentSessionId: COORD_SID,
        runs: [coordinator({ status: "done" }), child(CHILD_A_SID, "done")],
        isAlive: NEVER_ALIVE,
      }),
    ).toBe(false);
  });

  it("returns false when coordinator process is still alive (running for real, not deferred)", () => {
    expect(
      shouldFinalizeDeferredCoordinator({
        parentSessionId: COORD_SID,
        runs: [
          coordinator({ status: "running", endedAt: null }),
          child(CHILD_A_SID, "done"),
        ],
        isAlive: ALWAYS_ALIVE,
      }),
    ).toBe(false);
  });

  it("returns false when at least one child is still queued/running", () => {
    expect(
      shouldFinalizeDeferredCoordinator({
        parentSessionId: COORD_SID,
        runs: [
          coordinator({ status: "running", endedAt: null }),
          child(CHILD_A_SID, "running"),
        ],
        isAlive: NEVER_ALIVE,
      }),
    ).toBe(false);
  });

  it("returns false when no coordinator row exists for the given parentSessionId", () => {
    expect(
      shouldFinalizeDeferredCoordinator({
        parentSessionId: COORD_SID,
        runs: [child(CHILD_A_SID, "done")],
        isAlive: NEVER_ALIVE,
      }),
    ).toBe(false);
  });

  it("returns false when summary is missing (don't silently flip to DONE)", () => {
    // This is the regression guard for the silent-DONE bug: the legacy
    // finalizer flipped the row regardless of summary presence, so a
    // coordinator that exited without writing its contract output got
    // a green checkmark anyway.
    expect(
      shouldFinalizeDeferredCoordinator({
        parentSessionId: COORD_SID,
        runs: [
          coordinator({ status: "running", endedAt: null }),
          child(CHILD_A_SID, "done"),
        ],
        isAlive: NEVER_ALIVE,
        summaryMissing: true,
      }),
    ).toBe(false);
  });

  it("returns true when summary is explicitly present", () => {
    expect(
      shouldFinalizeDeferredCoordinator({
        parentSessionId: COORD_SID,
        runs: [
          coordinator({ status: "running", endedAt: null }),
          child(CHILD_A_SID, "done"),
        ],
        isAlive: NEVER_ALIVE,
        summaryMissing: false,
      }),
    ).toBe(true);
  });
});

describe("shouldMarkCoordinatorSummaryBlocked", () => {
  const baseRuns = [
    coordinator({ status: "running", endedAt: null }),
    child(CHILD_A_SID, "done"),
  ];

  it("returns true when summary missing AND attempts at cap AND all conditions hold", () => {
    expect(
      shouldMarkCoordinatorSummaryBlocked({
        parentSessionId: COORD_SID,
        runs: baseRuns,
        isAlive: NEVER_ALIVE,
        summaryMissing: true,
        summaryNudgeAttempts: 3,
      }),
    ).toBe(true);
  });

  it("returns false when attempts below cap (let nudge keep trying)", () => {
    expect(
      shouldMarkCoordinatorSummaryBlocked({
        parentSessionId: COORD_SID,
        runs: baseRuns,
        isAlive: NEVER_ALIVE,
        summaryMissing: true,
        summaryNudgeAttempts: 2,
      }),
    ).toBe(false);
  });

  it("returns false when summary is present (no failure to mark)", () => {
    expect(
      shouldMarkCoordinatorSummaryBlocked({
        parentSessionId: COORD_SID,
        runs: baseRuns,
        isAlive: NEVER_ALIVE,
        summaryMissing: false,
        summaryNudgeAttempts: 5,
      }),
    ).toBe(false);
  });

  it("returns false when coordinator process is still alive", () => {
    expect(
      shouldMarkCoordinatorSummaryBlocked({
        parentSessionId: COORD_SID,
        runs: baseRuns,
        isAlive: ALWAYS_ALIVE,
        summaryMissing: true,
        summaryNudgeAttempts: 5,
      }),
    ).toBe(false);
  });

  it("returns false when at least one child is still running", () => {
    expect(
      shouldMarkCoordinatorSummaryBlocked({
        parentSessionId: COORD_SID,
        runs: [
          coordinator({ status: "running", endedAt: null }),
          child(CHILD_A_SID, "running"),
        ],
        isAlive: NEVER_ALIVE,
        summaryMissing: true,
        summaryNudgeAttempts: 5,
      }),
    ).toBe(false);
  });

  it("returns false when coordinator status is no longer `running` (already settled)", () => {
    expect(
      shouldMarkCoordinatorSummaryBlocked({
        parentSessionId: COORD_SID,
        runs: [coordinator({ status: "done" }), child(CHILD_A_SID, "done")],
        isAlive: NEVER_ALIVE,
        summaryMissing: true,
        summaryNudgeAttempts: 5,
      }),
    ).toBe(false);
  });
});

