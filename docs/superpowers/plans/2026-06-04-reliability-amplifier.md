# Reliability Amplifier (Epic B1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the single-judge semantic gate into a 3-judge diverse-lens panel with majority consensus, add a mandatory coder self-review, and make semantic verification on by default.

**Architecture:** A generic panel runner (`libs/judgePanel.ts`) fans out N concurrent `runAgentGate` calls (one per lens) and a pure `aggregatePanel` applies majority. `libs/semanticVerifier.ts` calls it with three semantic lenses, keeps the `RunSemanticVerifier` result shape (now carrying `votes`), so the existing retry/commit plumbing is unchanged. A default-on flip + per-app `verifierPanel` size live in `libs/apps.ts`.

**Tech Stack:** TypeScript 5, Node, Vitest. Spawning via existing `runAgentGate` (libs/qualityGate.ts).

**Spec:** [docs/superpowers/specs/2026-06-04-reliability-amplifier-design.md](../specs/2026-06-04-reliability-amplifier-design.md)

---

## File Structure

**New**
- `libs/judgePanel.ts` — generic, semantic-agnostic: `aggregatePanel()` (pure majority) +
  `runGatePanel()` (fan out `runAgentGate` per lens, return raw outcomes).
- Tests under `libs/__tests__/`.

**Modified**
- `libs/meta.ts` — `RunSemanticVerifier` gains `votes?` + `panelSize?`.
- `libs/apps.ts` — `AppQuality.verifierPanel?: number`; parse it; add `semanticVerifierEnabled(app)` (default-on) + `resolvePanelSize(app)`.
- `libs/semanticVerifier.ts` — `SEMANTIC_LENSES`; `runSemanticVerifier` dispatches to the panel when size ≥ 2, else the single gate.
- `libs/runLifecycle.ts` — semantic gate eligibility uses `semanticVerifierEnabled(app)`.
- `prompts/report-template.md` — mandatory self-review step before the report.
- (UI) wherever the semantic verdict is shown — surface per-lens `votes`.

---

## Task 1: aggregatePanel — pure majority aggregation

**Files:**
- Create: `libs/judgePanel.ts`
- Test: `libs/__tests__/judgePanel.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// libs/__tests__/judgePanel.test.ts
import { describe, it, expect } from "vitest";
import { aggregatePanel, type PanelVote } from "../judgePanel";

const v = (lens: string, verdict: PanelVote["verdict"], reason = "r", concerns: string[] = []): PanelVote =>
  ({ lens, verdict, reason, concerns });

describe("aggregatePanel (N=3 majority)", () => {
  it("blocks (broken) when >= 2 of 3 are broken", () => {
    const r = aggregatePanel([v("a", "broken", "x"), v("b", "broken", "y"), v("c", "pass")], 3);
    expect(r.verdict).toBe("broken");
    expect(r.reason).toContain("x");
  });

  it("a lone broken (1 of 3) downgrades to drift, not pass", () => {
    const r = aggregatePanel([v("a", "broken", "x", ["c1"]), v("b", "pass"), v("c", "pass")], 3);
    expect(r.verdict).toBe("drift");
    expect(r.concerns).toContain("c1");
  });

  it("any drift with no majority-broken is drift", () => {
    const r = aggregatePanel([v("a", "drift"), v("b", "pass"), v("c", "pass")], 3);
    expect(r.verdict).toBe("drift");
  });

  it("all pass is pass", () => {
    const r = aggregatePanel([v("a", "pass"), v("b", "pass"), v("c", "pass")], 3);
    expect(r.verdict).toBe("pass");
  });

  it("inconclusive (fewer than majority usable) is skipped, never blocks", () => {
    const r = aggregatePanel([v("a", "broken", "x")], 3); // only 1 of 3 judges reported
    expect(r.verdict).toBe("skipped");
  });

  it("de-dupes and caps concerns at 10", () => {
    const many = Array.from({ length: 15 }, (_, i) => `c${i}`);
    const r = aggregatePanel(
      [v("a", "broken", "x", [...many, "c0"]), v("b", "broken", "y", ["c0", "z"])],
      3,
    );
    expect(r.concerns.length).toBeLessThanOrEqual(10);
    expect(new Set(r.concerns).size).toBe(r.concerns.length); // unique
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run libs/__tests__/judgePanel.test.ts`
Expected: FAIL — `Cannot find module '../judgePanel'`.

- [ ] **Step 3: Write minimal implementation**

```ts
// libs/judgePanel.ts
/**
 * Generic N-judge quality panel. Semantic-agnostic: it fans out the
 * existing single-judge `runAgentGate` runner once per lens and a pure
 * `aggregatePanel` applies majority consensus. Callers (e.g.
 * `semanticVerifier.ts`) own the lens definitions + verdict parsing.
 * See docs/superpowers/specs/2026-06-04-reliability-amplifier-design.md.
 */
import { runAgentGate, type AgentGateOutcome, type AgentGateOptions } from "./qualityGate";

export interface PanelVote {
  lens: string;
  verdict: "pass" | "drift" | "broken";
  reason: string;
  concerns: string[];
}

export interface PanelAggregate {
  verdict: "pass" | "drift" | "broken" | "skipped";
  reason: string;
  concerns: string[];
}

const CONCERNS_CAP = 10;

/**
 * Majority rule over the usable votes (skipped judges already dropped by
 * the caller). `panelSize` is the number of judges DISPATCHED — used to
 * decide whether enough reported back to be conclusive.
 *
 *   broken  : >= ceil(panelSize/2) votes are "broken"
 *   drift   : not majority-broken, but >= 1 broken OR >= 1 drift
 *             (a minority "broken" surfaces as drift, never vanishes)
 *   pass    : every usable vote is "pass"
 *   skipped : fewer than ceil(panelSize/2) usable votes (inconclusive) —
 *             fail-soft, the commit proceeds, never hard-block on infra loss
 */
export function aggregatePanel(votes: PanelVote[], panelSize: number): PanelAggregate {
  const majority = Math.ceil(panelSize / 2);
  if (votes.length < majority) {
    return {
      verdict: "skipped",
      reason: `inconclusive panel: only ${votes.length}/${panelSize} judges reported a usable verdict`,
      concerns: [],
    };
  }
  const broken = votes.filter((v) => v.verdict === "broken");
  const drift = votes.filter((v) => v.verdict === "drift");
  const dedupeCap = (xs: string[]) => Array.from(new Set(xs)).slice(0, CONCERNS_CAP);

  if (broken.length >= majority) {
    return {
      verdict: "broken",
      reason: broken.map((v) => `[${v.lens}] ${v.reason}`).join(" · "),
      concerns: dedupeCap(broken.flatMap((v) => v.concerns)),
    };
  }
  if (broken.length >= 1 || drift.length >= 1) {
    const flagged = [...broken, ...drift];
    return {
      verdict: "drift",
      reason: flagged.map((v) => `[${v.lens}] ${v.reason}`).join(" · "),
      concerns: dedupeCap(flagged.flatMap((v) => v.concerns)),
    };
  }
  return { verdict: "pass", reason: "panel consensus: pass", concerns: [] };
}

export interface PanelLens {
  /** Short key — also used in the verdict filename + vote label. */
  key: string;
  /** One-line lens nudge appended to the base brief. */
  nudge: string;
}

export type GateRunner = (opts: AgentGateOptions) => Promise<AgentGateOutcome>;

export interface RunGatePanelOptions {
  appPath: string;
  taskId: string;
  finishedRun: AgentGateOptions["finishedRun"];
  taskTitle: string;
  taskBody: string;
  /** Playbook role for every judge (e.g. "semantic-verifier"). */
  role: string;
  /** Base brief shared by all lenses. */
  baseBrief: string;
  /** Verdict filenames are `<prefix>-<lens.key>.json`. */
  verdictFilePrefix: string;
  lenses: PanelLens[];
  /** Injected for tests; defaults to the real runAgentGate. */
  gateRunner?: GateRunner;
}

/**
 * Run one judge per lens concurrently. Returns the raw outcome per lens;
 * the caller parses each verdict with its own schema validator.
 */
export async function runGatePanel(
  opts: RunGatePanelOptions,
): Promise<Array<{ lens: string; outcome: AgentGateOutcome }>> {
  const run = opts.gateRunner ?? runAgentGate;
  return Promise.all(
    opts.lenses.map(async (lens) => ({
      lens: lens.key,
      outcome: await run({
        appPath: opts.appPath,
        taskId: opts.taskId,
        finishedRun: opts.finishedRun,
        taskTitle: opts.taskTitle,
        taskBody: opts.taskBody,
        role: opts.role,
        briefBody: `${opts.baseBrief}\n\n## Lens: ${lens.key}\n${lens.nudge}`,
        verdictFileName: `${opts.verdictFilePrefix}-${lens.key}.json`,
      }),
    })),
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run libs/__tests__/judgePanel.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add libs/judgePanel.ts libs/__tests__/judgePanel.test.ts
git commit -m "feat(reliability): judge panel — aggregatePanel (majority) + runGatePanel

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: runGatePanel fan-out — verify lens briefs + filenames

**Files:**
- Modify: `libs/__tests__/judgePanel.test.ts` (append)

- [ ] **Step 1: Write the failing test (injected stub gateRunner)**

```ts
// append to libs/__tests__/judgePanel.test.ts
import { runGatePanel, type GateRunner } from "../judgePanel";
import type { Run } from "../meta";

const FINISHED: Run = {
  sessionId: "00000000-0000-4000-8000-000000000001",
  role: "coder", repo: "app", status: "done", startedAt: null, endedAt: null,
};

describe("runGatePanel", () => {
  it("runs one judge per lens with distinct verdict files + lens briefs", async () => {
    const calls: Array<{ verdictFileName: string; briefBody: string }> = [];
    const stub: GateRunner = async (o) => {
      calls.push({ verdictFileName: o.verdictFileName, briefBody: o.briefBody });
      return { kind: "spawned", sessionId: "s", verdict: { verdict: "pass", reason: "ok" } };
    };
    const results = await runGatePanel({
      appPath: "/app", taskId: "t_20260604_001", finishedRun: FINISHED,
      taskTitle: "T", taskBody: "B", role: "semantic-verifier",
      baseBrief: "BASE", verdictFilePrefix: "semantic-verdict",
      lenses: [
        { key: "correctness", nudge: "N1" },
        { key: "edge-cases", nudge: "N2" },
      ],
      gateRunner: stub,
    });
    expect(results.map((r) => r.lens)).toEqual(["correctness", "edge-cases"]);
    expect(calls.map((c) => c.verdictFileName)).toEqual([
      "semantic-verdict-correctness.json",
      "semantic-verdict-edge-cases.json",
    ]);
    expect(calls[0].briefBody).toContain("BASE");
    expect(calls[0].briefBody).toContain("N1");
  });
});
```

- [ ] **Step 2: Run test to verify it passes (logic already implemented in Task 1)**

Run: `npx vitest run libs/__tests__/judgePanel.test.ts`
Expected: PASS (Task 1 already implemented `runGatePanel`; this test pins the contract).

- [ ] **Step 3: Commit**

```bash
git add libs/__tests__/judgePanel.test.ts
git commit -m "test(reliability): pin runGatePanel lens-brief + verdict-file contract

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: RunSemanticVerifier gains votes + panelSize

**Files:**
- Modify: `libs/meta.ts:264-273` (the `RunSemanticVerifier` interface)
- Test: `libs/__tests__/semanticVotes.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// libs/__tests__/semanticVotes.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMeta, readMeta, writeMeta, type Meta, type RunSemanticVerifier } from "../meta";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "svotes-")); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function header(): Omit<Meta, "runs"> {
  return {
    taskId: "t_20260604_001", taskTitle: "x", taskBody: "y",
    taskStatus: "doing", taskSection: "DOING", taskChecked: false,
    createdAt: new Date().toISOString(),
  };
}

describe("RunSemanticVerifier votes/panelSize", () => {
  it("round-trips votes + panelSize through meta", () => {
    createMeta(dir, header());
    const meta = readMeta(dir)!;
    const sv: RunSemanticVerifier = {
      verdict: "broken", reason: "r", concerns: ["c"], durationMs: 1,
      panelSize: 3,
      votes: [
        { lens: "correctness", verdict: "broken", reason: "rc" },
        { lens: "edge-cases", verdict: "broken", reason: "re" },
        { lens: "regression", verdict: "pass", reason: "rr" },
      ],
    };
    meta.runs.push({
      sessionId: "00000000-0000-4000-8000-000000000002",
      role: "coder", repo: "app", status: "done", startedAt: null, endedAt: null,
      semanticVerifier: sv,
    });
    writeMeta(dir, meta);
    const back = readMeta(dir)!.runs[0].semanticVerifier!;
    expect(back.panelSize).toBe(3);
    expect(back.votes?.map((v) => v.lens)).toEqual(["correctness", "edge-cases", "regression"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run libs/__tests__/semanticVotes.test.ts`
Expected: FAIL — TS error: `votes` / `panelSize` not on `RunSemanticVerifier`.

- [ ] **Step 3: Write minimal implementation**

In `libs/meta.ts`, extend the `RunSemanticVerifier` interface (around line 264):

```ts
export interface RunSemanticVerifier {
  verdict: "pass" | "drift" | "broken" | "skipped";
  reason: string;
  /** Specific gaps the verifier identified (max ~10 surfaced). */
  concerns: string[];
  /** sessionId of the spawned `semantic-verifier` agent (first judge in panel mode). */
  verifierSessionId?: string | null;
  durationMs: number;
  retryScheduled?: boolean;
  /** Reliability Amplifier (B1): number of judges dispatched (1 = single). */
  panelSize?: number;
  /** Per-lens votes when run as a panel. Absent on legacy / single-judge runs. */
  votes?: Array<{
    lens: string;
    verdict: "pass" | "drift" | "broken";
    reason: string;
  }>;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run libs/__tests__/semanticVotes.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add libs/meta.ts libs/__tests__/semanticVotes.test.ts
git commit -m "feat(reliability): RunSemanticVerifier carries panel votes + size

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: AppQuality.verifierPanel + default-on helpers

**Files:**
- Modify: `libs/apps.ts` (`AppQuality` interface ~177; quality parser ~734)
- Test: `libs/__tests__/semanticEnabled.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// libs/__tests__/semanticEnabled.test.ts
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
```

> Confirm the exact type the helpers should accept (an `App` vs a `{ quality }` slice) against `libs/apps.ts`. The test uses a minimal `{ quality }` shape; if the real `App` type requires more fields, narrow the helper's parameter to `Pick<App, "quality">`.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run libs/__tests__/semanticEnabled.test.ts`
Expected: FAIL — helpers not exported.

- [ ] **Step 3: Write minimal implementation**

In `libs/apps.ts`, extend `AppQuality` (line ~177):

```ts
export interface AppQuality {
  critic?: boolean;
  verifier?: boolean;
  /** Reliability Amplifier (B1): semantic judges to run (1 = single, default 3). Clamped 1..5. */
  verifierPanel?: number;
}
```

Add the helpers near `DEFAULT_QUALITY` (after line ~182):

```ts
/**
 * Default-on flip for the Reliability Amplifier: the semantic verifier
 * runs unless the app explicitly opted out with `quality.verifier:false`.
 * (Pre-B1 this required `quality.verifier === true`.)
 */
export function semanticVerifierEnabled(app: Pick<App, "quality">): boolean {
  return app.quality?.verifier !== false;
}

/** Number of semantic judges to dispatch — clamped to 1..5, default 3. */
export function resolvePanelSize(app: Pick<App, "quality">): number {
  const n = app.quality?.verifierPanel;
  if (typeof n !== "number" || !Number.isFinite(n)) return 3;
  return Math.max(1, Math.min(5, Math.floor(n)));
}
```

In the quality parser (around line 734, where `qualityRaw` is read into the app), parse the
new field. Find the block that builds the `quality` object from `qualityRaw` and add:

```ts
// inside the quality normalization (mirror how `critic`/`verifier` are read)
verifierPanel:
  typeof (qualityRaw as { verifierPanel?: unknown })?.verifierPanel === "number"
    ? (qualityRaw as { verifierPanel: number }).verifierPanel
    : undefined,
```

> Match the existing normalization style for `critic`/`verifier` in that block — if they're read via a helper or inline `=== true`, follow the same shape for `verifierPanel` (a number passthrough; `resolvePanelSize` does the clamping at read time).

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run libs/__tests__/semanticEnabled.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add libs/apps.ts libs/__tests__/semanticEnabled.test.ts
git commit -m "feat(reliability): verifierPanel config + semanticVerifierEnabled default-on

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Wire runSemanticVerifier to the panel

**Files:**
- Modify: `libs/semanticVerifier.ts`
- Test: `libs/__tests__/semanticPanelDispatch.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// libs/__tests__/semanticPanelDispatch.test.ts
import { describe, it, expect } from "vitest";
import { SEMANTIC_LENSES } from "../semanticVerifier";

describe("SEMANTIC_LENSES", () => {
  it("defines exactly the three v1 lenses with nudges", () => {
    expect(SEMANTIC_LENSES.map((l) => l.key)).toEqual(["correctness", "edge-cases", "regression"]);
    for (const l of SEMANTIC_LENSES) expect(l.nudge.length).toBeGreaterThan(0);
  });
});
```

> The full dispatch (panel vs single) calls `runGatePanel`, which spawns agents — covered by
> manual smoke (Task 9), not a unit test. This task's automated check pins the lens set; the
> dispatch wiring is verified by typecheck + the smoke run.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run libs/__tests__/semanticPanelDispatch.test.ts`
Expected: FAIL — `SEMANTIC_LENSES` not exported.

- [ ] **Step 3: Write minimal implementation**

In `libs/semanticVerifier.ts`, add the lenses + panel import near the top:

```ts
import { runGatePanel, aggregatePanel, type PanelLens, type PanelVote } from "./judgePanel";
import { resolvePanelSize } from "./apps";

export const SEMANTIC_LENSES: PanelLens[] = [
  {
    key: "correctness",
    nudge: "Judge ONLY whether the diff satisfies the task body's acceptance criteria. Does it deliver what was asked, end to end?",
  },
  {
    key: "edge-cases",
    nudge: "Hunt for an input or state the diff handles WRONG — empty/boundary/error paths, off-by-one, missing null guards. Try to break it; if you find a real gap, verdict `broken`.",
  },
  {
    key: "regression",
    nudge: "Judge whether this change breaks EXISTING behavior or opens an input/boundary/security risk elsewhere in the codebase. Look beyond the touched lines.",
  },
];
```

Replace the body of `runSemanticVerifier` so it dispatches to the panel when size ≥ 2.
Locate the existing single-gate call (the `runAgentGate({...})` block, ~line 118) and the
`return { verdict: parsed.verdict, ... }` at the end (~line 141), and restructure to:

```ts
export async function runSemanticVerifier(
  opts: RunSemanticVerifierOptions,
): Promise<RunSemanticVerifier> {
  const start = Date.now();
  const skipped = (reason: string, sessionId?: string | null): RunSemanticVerifier => ({
    verdict: "skipped", reason, concerns: [], verifierSessionId: sessionId ?? null,
    durationMs: Date.now() - start,
  });

  const app = getApp(opts.finishedRun.repo);
  const panelSize = app ? resolvePanelSize(app) : 3;

  // Single-judge path (panelSize 1) — unchanged behavior.
  if (panelSize === 1) {
    const outcome = await runAgentGate({
      appPath: opts.appPath, taskId: opts.taskId, finishedRun: opts.finishedRun,
      taskTitle: opts.taskTitle, taskBody: opts.taskBody,
      role: SEMANTIC_VERIFIER_ROLE, briefBody: BRIEF_BODY, verdictFileName: VERDICT_FILE,
    });
    if (outcome.kind === "skipped") return skipped(outcome.reason, outcome.sessionId ?? null);
    const parsed = parseSemanticVerdict(outcome.verdict);
    if (!parsed) return skipped("verdict file did not match `{verdict, reason, concerns}` schema", outcome.sessionId);
    return {
      verdict: parsed.verdict, reason: parsed.reason, concerns: parsed.concerns,
      verifierSessionId: outcome.sessionId, durationMs: Date.now() - start, panelSize: 1,
    };
  }

  // Panel path: one judge per lens (capped to the defined lenses).
  const lenses = SEMANTIC_LENSES.slice(0, panelSize);
  const results = await runGatePanel({
    appPath: opts.appPath, taskId: opts.taskId, finishedRun: opts.finishedRun,
    taskTitle: opts.taskTitle, taskBody: opts.taskBody,
    role: SEMANTIC_VERIFIER_ROLE, baseBrief: BRIEF_BODY, verdictFilePrefix: "semantic-verdict",
    lenses,
  });

  const votes: PanelVote[] = [];
  let firstSessionId: string | null = null;
  for (const { lens, outcome } of results) {
    if (outcome.kind !== "spawned") continue;
    firstSessionId = firstSessionId ?? outcome.sessionId;
    const parsed = parseSemanticVerdict(outcome.verdict);
    if (!parsed) continue;
    votes.push({ lens, verdict: parsed.verdict, reason: parsed.reason, concerns: parsed.concerns });
  }

  const agg = aggregatePanel(votes, lenses.length);
  return {
    verdict: agg.verdict, reason: agg.reason, concerns: agg.concerns,
    verifierSessionId: firstSessionId, durationMs: Date.now() - start,
    panelSize: lenses.length,
    votes: votes.map((v) => ({ lens: v.lens, verdict: v.verdict, reason: v.reason })),
  };
}
```

> Keep the existing imports (`runAgentGate`, `parseSemanticVerdict`, `getApp`, etc.). The
> single-judge branch reuses `VERDICT_FILE` so legacy behavior (and the existing
> `semanticVerifier.test.ts`) is byte-for-byte the same when `verifierPanel: 1`.

- [ ] **Step 4: Run test + typecheck**

Run: `npx vitest run libs/__tests__/semanticPanelDispatch.test.ts && npx tsc --noEmit`
Expected: test PASS, typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add libs/semanticVerifier.ts libs/__tests__/semanticPanelDispatch.test.ts
git commit -m "feat(reliability): semantic verifier runs a 3-lens majority panel

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: Default-on flip in the post-exit semantic gate

**Files:**
- Modify: `libs/runLifecycle.ts:522` (the gate eligibility check)

- [ ] **Step 1: Apply the flip**

In `libs/runLifecycle.ts`, find `runSemanticVerifierGate` (~line 518). Add the import (top of
file, with the other `./apps` imports — it already imports `getApp`):

```ts
import { getApp, semanticVerifierEnabled } from "./apps";
```

Replace the opt-in check (line 522):

```ts
  // BEFORE:
  // if (!app || app.quality?.verifier !== true) {
  //   return "proceed";
  // }
  // AFTER (default-on — runs unless the app opted out):
  if (!app || !semanticVerifierEnabled(app)) {
    return "proceed";
  }
```

> Verify `getApp` is already imported in `runLifecycle.ts` (it is, used in `succeedRun`); just
> add `semanticVerifierEnabled` to that import. Update the function's doc comment above
> (line 514) from "Opt-in per app" to "Default-on; opt out via `quality.verifier:false`".

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add libs/runLifecycle.ts
git commit -m "feat(reliability): semantic gate is default-on (opt out via quality.verifier:false)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: Mandatory coder self-review in the report contract

**Files:**
- Modify: `prompts/report-template.md`

- [ ] **Step 1: Add the self-review step**

Read `prompts/report-template.md`. Before the section that defines the report fields
(`## Verdict` / `## Summary` / `## Changed files` …), insert a mandatory pre-report step:

```markdown
## Self-review (REQUIRED — do this BEFORE writing the report)

Before you report `DONE`, review your own work as a hostile reviewer would:

1. Run `git diff HEAD` and re-read every changed hunk against the `## Task` you were given.
2. List — to yourself — the issues a strict reviewer would flag: missed acceptance criteria,
   unhandled edge cases (empty / boundary / error inputs), changes that could break existing
   behavior, leftover debug code, or claims you can't actually back with the diff.
3. **Fix what you find** before reporting. Only report `DONE` once your own review is clean.

This is not optional. The bridge runs a multi-judge panel after you exit; catching issues
here is cheaper than a `-svretry` round.
```

> Place it so it's injected for coder-type roles. `prompts/report-template.md` is the
> canonical copy `libs/childPrompt.ts` injects into every child — confirm the heading nesting
> matches the surrounding template (don't break the `## Report` contract headings the
> downstream parser relies on).

- [ ] **Step 2: Commit**

```bash
git add prompts/report-template.md
git commit -m "docs(prompts): mandatory hostile self-review before the report

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 8: Surface panel votes in the UI

**Files:**
- Modify: wherever `semanticVerifier` results render (search `app/` for `semanticVerifier`).

- [ ] **Step 1: Find the render site**

Run: `grep -rn "semanticVerifier" app/ libs/client/` to find where the verdict is displayed
(likely the run detail / AgentTree / a gate-results panel). Identify the component that reads
`run.semanticVerifier`.

- [ ] **Step 2: Render the votes**

Where the verdict is shown, add the per-lens votes when present:

```tsx
{run.semanticVerifier?.votes && run.semanticVerifier.votes.length > 0 && (
  <ul className="mt-1 text-[11px] text-muted-foreground space-y-0.5">
    {run.semanticVerifier.votes.map((v, i) => (
      <li key={i}>
        <span className="font-mono">{v.lens}</span>:{" "}
        <span className={v.verdict === "broken" ? "text-red-500" : v.verdict === "drift" ? "text-amber-500" : "text-emerald-500"}>
          {v.verdict}
        </span>{" "}— {v.reason}
      </li>
    ))}
  </ul>
)}
```

> The client `Run`/`Meta` types may not include `semanticVerifier` yet. If TS errors,
> mirror the server `RunSemanticVerifier` shape (verdict/reason/concerns/votes/panelSize) into
> the client `Run` type in `libs/client/types.ts`, same way `mergeNotPushed` is mirrored.

- [ ] **Step 3: Typecheck + commit**

Run: `npx tsc --noEmit`

```bash
git add app libs/client/types.ts
git commit -m "feat(reliability): surface per-lens panel votes in the run detail

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 9: Full verification + smoke

**Files:** none (verification only)

- [ ] **Step 1: Full suite**

Run: `npx vitest run`
Expected: all suites pass (new + existing — no regressions).

- [ ] **Step 2: Typecheck + lint**

Run: `npx tsc --noEmit && npx eslint libs/judgePanel.ts libs/semanticVerifier.ts libs/apps.ts`
Expected: clean (the repo has 4 pre-existing eslint errors in `AppSettingsDialog.tsx` /
`AppSourceTreeTab.tsx` unrelated to this work — do not fix here).

- [ ] **Step 3: Manual smoke**

On an app with verify configured, dispatch a task that produces a small diff. Confirm in the
run tree:
1. After the coder exits, **3** `semantic-verifier` judge runs appear.
2. `run.semanticVerifier.votes` has three entries (one per lens) with verdicts.
3. A diff that genuinely fails the task is `broken` only when ≥ 2 lenses agree; a single
   dissent shows as `drift` (commit proceeds, concerns surfaced).
4. Setting `quality.verifierPanel: 1` on the app reproduces a single judge.

---

## Self-review (completed by plan author)

**Spec coverage:** panel + majority → Tasks 1,5; lenses → Task 5; default-on → Tasks 4,6;
self-review → Task 7; votes in meta + UI → Tasks 3,8; config (`verifierPanel`) → Task 4;
fail-soft inconclusive → Task 1 (`aggregatePanel` skipped branch); back-compat panelSize 1 →
Task 5. All spec sections map to ≥ 1 task.

**Placeholder scan:** backend tasks (1–6) contain complete code. Tasks 4, 6, 8 carry explicit
"confirm against the file" notes (the apps.ts quality-parser block, the runLifecycle import,
and the UI render site weren't all read line-for-line during planning) — flagged inline, not
silent TODOs.

**Type consistency:** `PanelVote` / `PanelAggregate` / `PanelLens` / `GateRunner` defined in
Task 1 are reused in Tasks 2, 5. `RunSemanticVerifier.votes` (Task 3) matches the vote shape
written in Task 5. `semanticVerifierEnabled` / `resolvePanelSize` (Task 4) are consumed in
Tasks 5, 6 with the same signatures.

**Confirmation points for the implementer (not blockers):**
- The exact `quality` normalization block in `libs/apps.ts` (~734) — match `critic`/`verifier`'s style for `verifierPanel`.
- The UI render site for `run.semanticVerifier` (Task 8) + whether the client `Run` type needs the field mirrored.
