import { describe, it, expect } from "vitest";
import {
  computeGateStatus,
  renderGateStatusMarkdown,
  renderGateStatusLine,
  type GateStatus,
} from "../gateStatus";
import type { Meta, Run } from "../meta";

const HEADER: Omit<Meta, "runs"> = {
  taskId: "t_20260710_001",
  taskTitle: "Test task",
  taskBody: "body",
  taskStatus: "todo",
  taskSection: "DOING",
  taskChecked: false,
  createdAt: "2026-07-10T10:00:00Z",
};

function run(overrides: Partial<Run> & { sessionId: string }): Run {
  return {
    role: "coder",
    repo: "app1",
    status: "done",
    startedAt: "2026-07-10T10:00:00Z",
    endedAt: "2026-07-10T10:05:00Z",
    ...overrides,
  };
}

function meta(runs: Run[]): Meta {
  return { ...HEADER, runs };
}

describe("computeGateStatus", () => {
  it("no gates configured => gates:[] and allGreen:true", () => {
    const m = meta([run({ sessionId: "s1" })]);
    const status = computeGateStatus(m);
    expect(status.gates).toEqual([]);
    expect(status.allGreen).toBe(true);
  });

  it("passing verify + passing semantic verifier => allGreen:true", () => {
    const m = meta([
      run({
        sessionId: "s1",
        verify: {
          steps: [{ name: "test", cmd: "npm test", ok: true, exitCode: 0, durationMs: 10, output: "" }],
          passed: true,
          startedAt: "2026-07-10T10:00:00Z",
          endedAt: "2026-07-10T10:01:00Z",
        },
        semanticVerifier: {
          verdict: "pass",
          reason: "accomplishes the task",
          concerns: [],
          durationMs: 5,
        },
      }),
    ]);
    const status = computeGateStatus(m);
    expect(status.allGreen).toBe(true);
    expect(status.gates).toHaveLength(2);
    expect(status.gates.every((g) => g.verdict === "pass")).toBe(true);
  });

  it("the newest retry attempt's verify failure is not masked by an older passing attempt", () => {
    const m = meta([
      run({
        sessionId: "s1",
        role: "coder",
        verify: {
          steps: [{ name: "test", cmd: "npm test", ok: true, exitCode: 0, durationMs: 10, output: "" }],
          passed: true,
          startedAt: "2026-07-10T10:00:00Z",
          endedAt: "2026-07-10T10:01:00Z",
        },
      }),
      run({
        sessionId: "s2",
        role: "coder-vretry",
        retryOf: "s1",
        retryAttempt: 1,
        verify: {
          steps: [{ name: "test", cmd: "npm test", ok: false, exitCode: 1, durationMs: 10, output: "" }],
          passed: false,
          startedAt: "2026-07-10T10:02:00Z",
          endedAt: "2026-07-10T10:03:00Z",
        },
      }),
    ]);
    const status = computeGateStatus(m);
    expect(status.allGreen).toBe(false);
    const verifyEntries = status.gates.filter((g) => g.name === "verify");
    expect(verifyEntries).toHaveLength(1);
    expect(verifyEntries[0].verdict).toBe("fail");
  });

  it("a confidence-held run surfaces a held verdict", () => {
    const m = meta([
      run({
        sessionId: "s1",
        confidence: { score: 42, band: "low", heldAt: "2026-07-10T10:05:00Z", reviewedBy: null },
      }),
    ]);
    const status = computeGateStatus(m);
    expect(status.allGreen).toBe(false);
    const confidenceEntries = status.gates.filter((g) => g.name === "confidence");
    expect(confidenceEntries).toHaveLength(1);
    expect(confidenceEntries[0].verdict).toBe("held");
  });

  it("a reviewed confidence hold no longer counts as held", () => {
    const m = meta([
      run({
        sessionId: "s1",
        confidence: {
          score: 42,
          band: "low",
          heldAt: "2026-07-10T10:05:00Z",
          reviewedBy: { label: "operator", at: "2026-07-10T10:06:00Z" },
        },
      }),
    ]);
    const status = computeGateStatus(m);
    expect(status.gates[0].verdict).toBe("pass");
    expect(status.allGreen).toBe(true);
  });

  it("ignores coordinator runs even when they carry gate fields", () => {
    const m = meta([
      run({
        sessionId: "s1",
        role: "coordinator",
        repo: "claude-bridge",
        verify: {
          steps: [{ name: "test", cmd: "npm test", ok: false, exitCode: 1, durationMs: 10, output: "" }],
          passed: false,
          startedAt: "2026-07-10T10:00:00Z",
          endedAt: "2026-07-10T10:01:00Z",
        },
      }),
    ]);
    const status = computeGateStatus(m);
    expect(status.gates).toEqual([]);
    expect(status.allGreen).toBe(true);
  });

  it("skipped verdicts count as green (non-blocking)", () => {
    const m = meta([
      run({
        sessionId: "s1",
        verifier: {
          verdict: "skipped",
          reason: "no report file",
          claimedFiles: [],
          actualFiles: [],
          unmatchedClaims: [],
          unclaimedActual: [],
          durationMs: 1,
        },
      }),
    ]);
    const status = computeGateStatus(m);
    expect(status.allGreen).toBe(true);
    expect(status.gates[0].verdict).toBe("skipped");
  });

  it("style critic 'drift' is non-blocking: verdict 'drift', allGreen stays true", () => {
    const m = meta([
      run({
        sessionId: "s1",
        styleCritic: {
          verdict: "drift",
          reason: "minor deviations",
          issues: ["naming slightly off"],
          durationMs: 3,
        },
      }),
    ]);
    const status = computeGateStatus(m);
    expect(status.allGreen).toBe(true);
    expect(status.gates.find((g) => g.name === "style")?.verdict).toBe("drift");
  });

  it("semantic verifier 'drift' is non-blocking: verdict 'drift', allGreen stays true", () => {
    const m = meta([
      run({
        sessionId: "s1",
        semanticVerifier: {
          verdict: "drift",
          reason: "partial progress, commit proceeds",
          concerns: ["edge case untested"],
          durationMs: 4,
        },
      }),
    ]);
    const status = computeGateStatus(m);
    expect(status.allGreen).toBe(true);
    expect(status.gates.find((g) => g.name === "semantic")?.verdict).toBe("drift");
  });

  it("claim-vs-diff 'drift' genuinely blocks (runLifecycle.ts:416-418) => fail", () => {
    const m = meta([
      run({
        sessionId: "s1",
        verifier: {
          verdict: "drift",
          reason: "claimed files not in diff",
          claimedFiles: ["a.ts"],
          actualFiles: [],
          unmatchedClaims: ["a.ts"],
          unclaimedActual: [],
          durationMs: 2,
        },
      }),
    ]);
    const status = computeGateStatus(m);
    expect(status.allGreen).toBe(false);
    expect(status.gates.find((g) => g.name === "claim")?.verdict).toBe("fail");
  });

  it("style critic 'alien' and semantic 'broken' verdicts fail the gate", () => {
    const m = meta([
      run({
        sessionId: "s1",
        styleCritic: {
          verdict: "alien",
          reason: "doesn't match codebase conventions",
          issues: ["reinvents an existing helper"],
          durationMs: 3,
        },
        semanticVerifier: {
          verdict: "broken",
          reason: "does not accomplish the task",
          concerns: ["missing the core feature"],
          durationMs: 4,
        },
      }),
    ]);
    const status = computeGateStatus(m);
    expect(status.allGreen).toBe(false);
    expect(status.gates.find((g) => g.name === "style")?.verdict).toBe("fail");
    expect(status.gates.find((g) => g.name === "semantic")?.verdict).toBe("fail");
  });

  it("two independent (non-retry) runs of the same role+repo each surface their own latest gate result", () => {
    const m = meta([
      run({
        sessionId: "s1",
        verify: {
          steps: [],
          passed: true,
          startedAt: "2026-07-10T10:00:00Z",
          endedAt: "2026-07-10T10:01:00Z",
        },
      }),
      run({
        sessionId: "s2",
        verify: {
          steps: [{ name: "test", cmd: "npm test", ok: false, exitCode: 1, durationMs: 1, output: "" }],
          passed: false,
          startedAt: "2026-07-10T11:00:00Z",
          endedAt: "2026-07-10T11:01:00Z",
        },
      }),
    ]);
    const status = computeGateStatus(m);
    expect(status.gates).toHaveLength(2);
    expect(status.allGreen).toBe(false);
  });
});

describe("renderGateStatusMarkdown", () => {
  it("renders a 'no gates configured' message for an empty status", () => {
    const status: GateStatus = { gates: [], allGreen: true };
    const md = renderGateStatusMarkdown(status);
    expect(md).toContain("## Gate status");
    expect(md.toLowerCase()).toContain("no gates configured");
  });

  it("renders a table row per gate with an icon + verdict", () => {
    const status: GateStatus = {
      allGreen: false,
      gates: [
        { name: "verify", verdict: "pass", detail: "coder@app1 — all steps passed" },
        { name: "style", verdict: "fail", detail: "coder@app1 — alien" },
      ],
    };
    const md = renderGateStatusMarkdown(status);
    expect(md).toContain("## Gate status");
    expect(md).toContain("verify");
    expect(md).toContain("style");
    expect(md).toContain("✅");
    expect(md).toContain("🔴");
  });
});

describe("renderGateStatusLine", () => {
  it("returns empty string when no gates are configured", () => {
    expect(renderGateStatusLine({ gates: [], allGreen: true })).toBe("");
  });

  it("renders 'all green' when every gate passes", () => {
    const status: GateStatus = {
      allGreen: true,
      gates: [{ name: "verify", verdict: "pass" }],
    };
    expect(renderGateStatusLine(status)).toBe("Gates: ✅ all green");
  });

  it("stays green but notes non-blocking drift", () => {
    const status: GateStatus = {
      allGreen: true,
      gates: [
        { name: "verify", verdict: "pass" },
        { name: "style", verdict: "drift", detail: "coder@app1 — minor deviations" },
      ],
    };
    expect(renderGateStatusLine(status)).toBe("Gates: ✅ all green (1 drift note)");
  });

  it("renders the failing gate name + verdict for a single failure", () => {
    const status: GateStatus = {
      allGreen: false,
      gates: [
        { name: "verify", verdict: "fail", detail: "coder@app1 — test failed" },
      ],
    };
    expect(renderGateStatusLine(status)).toBe("Gates: 🔴 verify fail");
  });
});
