# Intent & Planning Gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Insert a bridge-enforced gate between "a prompt arrives" and "a mutating agent runs" — always plan, pause to ask only when ambiguous, route plan approval by share grant.

**Architecture:** Hybrid. A pure gate function (`libs/planGate.ts`) is enforced in code at `POST /api/tasks/:id/agents` (mutating roles 423 until `intake.status === "approved"`). The *reasoning* reuses the existing `planner` role; the coordinator stays the single orchestrator. A lifecycle hook derives the gate verdict from the planner's output on exit; an approval endpoint (gated by a new `approvePlan` share grant) flips the gate and continues the coordinator via the existing `POST /api/tasks/:id/continue` path.

**Tech Stack:** Next.js 16 (App Router), React 19, TypeScript 5, Tailwind v4, Radix UI, Vitest. Runtime: Bun/Node. State persisted as JSON under `sessions/<id>/meta.json` and `.bridge-state/`.

**Spec:** [docs/superpowers/specs/2026-06-04-intent-planning-gate-design.md](../specs/2026-06-04-intent-planning-gate-design.md)

---

## File Structure

**New**
- `libs/planGate.ts` — pure logic: types, `isMutatingRole`, `canApprove`, `evaluatePlanGate`, `deriveGateVerdict`, `defaultIntake`.
- `libs/planGateConfig.ts` — operator config store (`.bridge-state/plan-gate.json`).
- `libs/planGateLifecycle.ts` — `resolvePlanGateAfterPlanner()` (derive verdict on planner exit, auto-approve + continue).
- `app/api/tasks/[id]/plan/route.ts` — `GET` plan + intake projection.
- `app/api/tasks/[id]/plan/approve/route.ts` — `POST` approve / request-changes / reject.
- `app/api/settings/plan-gate/route.ts` — `GET`/`PUT` operator gate config.
- `app/_components/PlanReviewCard.tsx` — shared plan-review UI (operator + guest).
- Tests under `libs/__tests__/`.

**Modified**
- `libs/meta.ts` — add `intake?` to `Meta`; `readIntake`/`setIntake`.
- `libs/shareStore.ts` — add `approvePlan` grant.
- `libs/guestAccess.ts` — allowlist `GET plan` + `POST plan/approve`.
- `app/api/tasks/[id]/agents/route.ts` — call `evaluatePlanGate` first.
- `libs/runLifecycle.ts` — call `resolvePlanGateAfterPlanner` on planner exit.
- `app/api/tasks/route.ts` — set `intake.status = planning` when gate applies.
- `prompts/playbooks/planner.md`, `prompts/coordinator.md`, `prompts/coordinator-playbook.md` — gate directives.
- Operator task page + guest share page + board card — render `PlanReviewCard` / badge.
- Share create/edit dialog — `approvePlan` checkbox.

---

## Task 1: planGate.ts — core gate logic (pure)

**Files:**
- Create: `libs/planGate.ts`
- Test: `libs/__tests__/planGate.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// libs/__tests__/planGate.test.ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run libs/__tests__/planGate.test.ts`
Expected: FAIL — `Cannot find module '../planGate'`.

- [ ] **Step 3: Write minimal implementation**

```ts
// libs/planGate.ts
/**
 * Pure logic for the Intent & Planning Gate (Epic A). No I/O — the route
 * layer computes `gateApplies` (config + actor) and reads/writes intake
 * via `libs/meta.ts`. Kept side-effect-free so it unit-tests trivially.
 * See docs/superpowers/specs/2026-06-04-intent-planning-gate-design.md.
 */

export type IntakeStatus =
  | "none"
  | "planning"
  | "awaiting-approval"
  | "approved"
  | "error";

export type GateVerdict = "clear" | "needs-decision";

export interface IntakeQuestion {
  id: string;
  text: string;
  options?: string[];
  recommended?: string;
}

export interface IntakeAnswer {
  questionId: string;
  answer: string;
  answeredBy: string;
  at: string;
}

export interface IntakeActorRef {
  kind: "operator" | "guest";
  label: string;
}

export interface IntakeRecord {
  status: IntakeStatus;
  verdict: GateVerdict | null;
  summary: string | null;
  questions: IntakeQuestion[];
  answers: IntakeAnswer[];
  /** Planner session that produced the current plan, if any. */
  planSessionId: string | null;
  submittedBy: IntakeActorRef | null;
  approvedBy: (IntakeActorRef & { at: string }) | null;
  /** How many clarify cycles have run (bounded by config.maxClarifyRounds). */
  rounds: number;
  updatedAt: string;
}

/** Roles that never write source — always allowed to run under the gate. */
const NON_MUTATING_ROLES = [
  "planner",
  "reviewer",
  "ui-tester",
  "semantic-verifier",
  "style-critic",
  "devops",
];

/**
 * A role is mutating unless it equals — or is a suffixed variant of
 * (`<base>-...`) — a known analysis role. Handles `coder-phase24`
 * (mutating) and `planner-api` / `ui-tester` (non-mutating).
 */
export function isMutatingRole(role: string): boolean {
  const r = role.toLowerCase();
  for (const base of NON_MUTATING_ROLES) {
    if (r === base || r.startsWith(base + "-")) return false;
  }
  return true;
}

export type ApproverActor =
  | { kind: "operator" }
  | { kind: "guest"; grants: { approvePlan?: boolean } };

export function canApprove(actor: ApproverActor): boolean {
  if (actor.kind === "operator") return true;
  return actor.grants.approvePlan === true;
}

export interface PlanGateInput {
  role: string;
  intakeStatus: IntakeStatus;
  /** config.operatorEnabled || actor.kind === "guest" — computed by caller. */
  gateApplies: boolean;
}

export interface PlanGateDecision {
  allowed: boolean;
  reason: string;
  /** True when the caller should flip intake → planning and kick the coordinator. */
  kickPlanning: boolean;
}

export function evaluatePlanGate(input: PlanGateInput): PlanGateDecision {
  if (!input.gateApplies) {
    return { allowed: true, reason: "gate off for this actor", kickPlanning: false };
  }
  if (!isMutatingRole(input.role)) {
    return { allowed: true, reason: "non-mutating role", kickPlanning: false };
  }
  if (input.intakeStatus === "approved") {
    return { allowed: true, reason: "plan approved", kickPlanning: false };
  }
  return {
    allowed: false,
    reason: `plan-gate: intake is '${input.intakeStatus}', not 'approved'`,
    kickPlanning: input.intakeStatus === "none",
  };
}

export function defaultIntake(): IntakeRecord {
  return {
    status: "none",
    verdict: null,
    summary: null,
    questions: [],
    answers: [],
    planSessionId: null,
    submittedBy: null,
    approvedBy: null,
    rounds: 0,
    updatedAt: new Date(0).toISOString(),
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run libs/__tests__/planGate.test.ts`
Expected: PASS (all cases green).

- [ ] **Step 5: Commit**

```bash
git add libs/planGate.ts libs/__tests__/planGate.test.ts
git commit -m "feat(plan-gate): pure gate logic — evaluatePlanGate, isMutatingRole, canApprove

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: deriveGateVerdict — map planner output → verdict (pure)

**Files:**
- Modify: `libs/planGate.ts` (append)
- Test: `libs/__tests__/planGateVerdict.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// libs/__tests__/planGateVerdict.test.ts
import { describe, it, expect } from "vitest";
import { deriveGateVerdict } from "../planGate";

describe("deriveGateVerdict", () => {
  it("uses intake.json verdict when present and valid", () => {
    const r = deriveGateVerdict({
      intakeJson: {
        verdict: "needs-decision",
        summary: "Build a CSV export",
        questions: [{ id: "q1", text: "Which columns?", options: ["all", "subset"] }],
      },
      planMd: "# Plan\n## Questions for the user\n- ignored, json wins",
    });
    expect(r.verdict).toBe("needs-decision");
    expect(r.summary).toBe("Build a CSV export");
    expect(r.questions).toHaveLength(1);
    expect(r.questions[0].id).toBe("q1");
  });

  it("falls back to parsing plan.md questions when json is absent", () => {
    const r = deriveGateVerdict({
      intakeJson: null,
      planMd: [
        "# Plan",
        "## Questions for the user",
        "- Should deletes be soft or hard?",
        "- Which timezone for timestamps?",
        "## Out of scope",
        "- migrations",
      ].join("\n"),
    });
    expect(r.verdict).toBe("needs-decision");
    expect(r.questions.map((q) => q.text)).toEqual([
      "Should deletes be soft or hard?",
      "Which timezone for timestamps?",
    ]);
  });

  it("is clear when plan.md questions section is empty or (none)", () => {
    const r = deriveGateVerdict({
      intakeJson: null,
      planMd: "# Plan\n## Questions for the user\n(none)\n## Out of scope\n- x",
    });
    expect(r.verdict).toBe("clear");
    expect(r.questions).toEqual([]);
  });

  it("fails open to clear when nothing is parseable", () => {
    const r = deriveGateVerdict({ intakeJson: null, planMd: null });
    expect(r.verdict).toBe("clear");
  });

  it("ignores an invalid json verdict and falls back", () => {
    const r = deriveGateVerdict({
      intakeJson: { verdict: "garbage", questions: [] },
      planMd: "## Questions for the user\n- real question?",
    });
    expect(r.verdict).toBe("needs-decision");
    expect(r.questions[0].text).toBe("real question?");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run libs/__tests__/planGateVerdict.test.ts`
Expected: FAIL — `deriveGateVerdict is not exported`.

- [ ] **Step 3: Write minimal implementation (append to `libs/planGate.ts`)**

```ts
// --- append to libs/planGate.ts ---

export interface PlannerOutput {
  /** Parsed sessions/<id>/intake.json, or null when absent/corrupt. */
  intakeJson?: {
    verdict?: unknown;
    summary?: unknown;
    questions?: unknown;
  } | null;
  /** Raw sessions/<id>/plan.md text, or null. */
  planMd?: string | null;
}

export interface DerivedVerdict {
  verdict: GateVerdict;
  summary: string | null;
  questions: IntakeQuestion[];
}

function normalizeQuestions(raw: unknown): IntakeQuestion[] {
  if (!Array.isArray(raw)) return [];
  const out: IntakeQuestion[] = [];
  raw.forEach((q, i) => {
    if (!q || typeof q !== "object") return;
    const obj = q as Record<string, unknown>;
    const text = typeof obj.text === "string" ? obj.text.trim() : "";
    if (!text) return;
    out.push({
      id: typeof obj.id === "string" && obj.id ? obj.id : `q${i + 1}`,
      text,
      options:
        Array.isArray(obj.options) && obj.options.every((o) => typeof o === "string")
          ? (obj.options as string[])
          : undefined,
      recommended: typeof obj.recommended === "string" ? obj.recommended : undefined,
    });
  });
  return out;
}

/** Extract bullet questions under a `## Questions for the user` heading. */
function parsePlanQuestions(planMd: string): IntakeQuestion[] {
  const lines = planMd.split(/\r?\n/);
  const start = lines.findIndex((l) => /^##\s+questions for the user/i.test(l.trim()));
  if (start === -1) return [];
  const out: IntakeQuestion[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line.startsWith("## ")) break; // next section
    const m = /^[-*]\s+(.*)$/.exec(line);
    if (!m) continue;
    const text = m[1].trim();
    if (!text || /^\(none\)$/i.test(text)) continue;
    out.push({ id: `q${out.length + 1}`, text });
  }
  return out;
}

export function deriveGateVerdict(out: PlannerOutput): DerivedVerdict {
  const j = out.intakeJson;
  if (j && (j.verdict === "clear" || j.verdict === "needs-decision")) {
    const questions = normalizeQuestions(j.questions);
    return {
      verdict: j.verdict === "needs-decision" && questions.length === 0 ? "clear" : j.verdict,
      summary: typeof j.summary === "string" ? j.summary : null,
      questions,
    };
  }
  // Fallback: parse plan.md. Fail open to "clear" when nothing parses.
  const planMd = out.planMd ?? "";
  const questions = planMd ? parsePlanQuestions(planMd) : [];
  return {
    verdict: questions.length > 0 ? "needs-decision" : "clear",
    summary: null,
    questions,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run libs/__tests__/planGateVerdict.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add libs/planGate.ts libs/__tests__/planGateVerdict.test.ts
git commit -m "feat(plan-gate): deriveGateVerdict with intake.json + plan.md fallback

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: planGateConfig.ts — operator config store

**Files:**
- Create: `libs/planGateConfig.ts`
- Test: `libs/__tests__/planGateConfig.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// libs/__tests__/planGateConfig.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { readPlanGateConfig, writePlanGateConfig, _resetForTests } from "../planGateConfig";

describe("planGateConfig", () => {
  beforeEach(() => _resetForTests());

  it("defaults to operator gate on, 3 clarify rounds", () => {
    const c = readPlanGateConfig();
    expect(c.operatorEnabled).toBe(true);
    expect(c.maxClarifyRounds).toBe(3);
  });

  it("patches and persists fields", () => {
    const c = writePlanGateConfig({ operatorEnabled: false });
    expect(c.operatorEnabled).toBe(false);
    expect(c.maxClarifyRounds).toBe(3);
    expect(readPlanGateConfig().operatorEnabled).toBe(false);
  });

  it("clamps maxClarifyRounds to >= 1", () => {
    expect(writePlanGateConfig({ maxClarifyRounds: 0 }).maxClarifyRounds).toBe(1);
    expect(writePlanGateConfig({ maxClarifyRounds: -5 }).maxClarifyRounds).toBe(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run libs/__tests__/planGateConfig.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```ts
// libs/planGateConfig.ts
/**
 * Operator-level config for the Intent & Planning Gate. Backed by
 * `.bridge-state/plan-gate.json`. Mirrors the shareStore globalThis +
 * atomic-write pattern (single-process bridge → authoritative in-memory
 * copy, write-through on mutation).
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { BRIDGE_STATE_DIR } from "./paths";
import { writeJsonAtomic } from "./atomicWrite";

const CONFIG_FILE = join(BRIDGE_STATE_DIR, "plan-gate.json");

export interface PlanGateConfig {
  /** When true, the gate also applies to the operator (smart mode). Guests are always gated regardless. */
  operatorEnabled: boolean;
  /** Max clarify cycles before forcing awaiting-approval (>= 1). */
  maxClarifyRounds: number;
}

const DEFAULTS: PlanGateConfig = { operatorEnabled: true, maxClarifyRounds: 3 };

interface State {
  data: PlanGateConfig;
  loaded: boolean;
}
const G = globalThis as unknown as { __bridgePlanGateConfig?: State };
const state: State =
  G.__bridgePlanGateConfig ?? (G.__bridgePlanGateConfig = { data: { ...DEFAULTS }, loaded: false });

function load(): void {
  if (state.loaded) return;
  try {
    if (existsSync(CONFIG_FILE)) {
      const parsed = JSON.parse(readFileSync(CONFIG_FILE, "utf8")) as Partial<PlanGateConfig>;
      state.data = normalize({ ...DEFAULTS, ...parsed });
    }
  } catch {
    state.data = { ...DEFAULTS };
  }
  state.loaded = true;
}

function normalize(c: PlanGateConfig): PlanGateConfig {
  return {
    operatorEnabled: !!c.operatorEnabled,
    maxClarifyRounds: Math.max(1, Math.floor(Number(c.maxClarifyRounds) || DEFAULTS.maxClarifyRounds)),
  };
}

export function readPlanGateConfig(): PlanGateConfig {
  load();
  return { ...state.data };
}

export function writePlanGateConfig(patch: Partial<PlanGateConfig>): PlanGateConfig {
  load();
  state.data = normalize({ ...state.data, ...patch });
  writeJsonAtomic(CONFIG_FILE, state.data);
  return { ...state.data };
}

/** Test-only: reset to defaults without touching disk. */
export function _resetForTests(): void {
  state.data = { ...DEFAULTS };
  state.loaded = true;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run libs/__tests__/planGateConfig.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add libs/planGateConfig.ts libs/__tests__/planGateConfig.test.ts
git commit -m "feat(plan-gate): operator config store (.bridge-state/plan-gate.json)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: shareStore — add `approvePlan` grant

**Files:**
- Modify: `libs/shareStore.ts` (`ShareGrants`, `normalizeGrants`)
- Test: `libs/__tests__/shareApprovePlan.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// libs/__tests__/shareApprovePlan.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { createShare, _resetForTests } from "../shareStore";

const baseGit = { branchMode: "current" as const, autoCommit: false, autoPush: false };

describe("approvePlan grant", () => {
  beforeEach(() => _resetForTests());

  it("defaults approvePlan to false when omitted (back-compat)", () => {
    const { share } = createShare({
      taskId: "t_20260604_001",
      grants: { sendMessage: true } as any,
      git: baseGit,
    });
    expect(share.grants.approvePlan).toBe(false);
  });

  it("honors an explicit approvePlan=true", () => {
    const { share } = createShare({
      taskId: "t_20260604_001",
      grants: { sendMessage: true, approvePlan: true } as any,
      git: baseGit,
    });
    expect(share.grants.approvePlan).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run libs/__tests__/shareApprovePlan.test.ts`
Expected: FAIL — `share.grants.approvePlan` is `undefined`.

- [ ] **Step 3: Write minimal implementation**

In `libs/shareStore.ts`, add the field to the `ShareGrants` interface (after `push`):

```ts
  /** Push commits (implies `commit`). */
  push: boolean;
  /** Approve a task's intake plan so coding may proceed (Intent & Planning Gate). */
  approvePlan: boolean;
```

In `normalizeGrants`, add normalization (after the `spawnAgent` line, before the return):

```ts
  // Intent & Planning Gate: default false for shares created before this
  // grant existed (and callers that omit it) — a guest can't approve
  // plans unless the operator explicitly grants it.
  const approvePlan = !!g.approvePlan;
  return {
    sendMessage: !!g.sendMessage,
    spawnAgent,
    answerPermission: !!g.answerPermission,
    commit,
    push: !!g.push,
    approvePlan,
  };
```

> Note: `ShareView` already spreads all non-`tokenHash` fields, so it picks up `approvePlan` automatically.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run libs/__tests__/shareApprovePlan.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add libs/shareStore.ts libs/__tests__/shareApprovePlan.test.ts
git commit -m "feat(share): add approvePlan grant (default false, back-compat)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: meta.ts — `intake` field + read/set helpers

**Files:**
- Modify: `libs/meta.ts`
- Test: `libs/__tests__/metaIntake.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// libs/__tests__/metaIntake.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInitialMeta, writeMeta, readMeta, readIntake, setIntake } from "../meta";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "intake-")); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("intake meta helpers", () => {
  it("legacy meta with no intake reads as null (migration-safe)", () => {
    const meta = createInitialMeta({ taskId: "t_20260604_001", taskTitle: "x", taskBody: "y" });
    delete (meta as any).intake;
    writeMeta(dir, meta);
    expect(readIntake(dir)).toBeNull();
  });

  it("setIntake creates an intake record from defaults and patches it", async () => {
    const meta = createInitialMeta({ taskId: "t_20260604_001", taskTitle: "x", taskBody: "y" });
    writeMeta(dir, meta);
    const rec = await setIntake(dir, { status: "planning" });
    expect(rec?.status).toBe("planning");
    expect(readIntake(dir)?.status).toBe("planning");
  });

  it("setIntake on a missing task returns null", async () => {
    expect(await setIntake(join(dir, "nope"), { status: "planning" })).toBeNull();
  });
});
```

> Confirm the real factory name for an empty meta in `libs/meta.ts` (search for the exported function that builds the initial meta — near `writeMeta`/`readMeta`). If it differs from `createInitialMeta`, update the import and the calls in this test accordingly before running.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run libs/__tests__/metaIntake.test.ts`
Expected: FAIL — `readIntake`/`setIntake` not exported.

- [ ] **Step 3: Write minimal implementation**

In `libs/meta.ts`, add a type-only import near the top imports:

```ts
import type { IntakeRecord } from "./planGate";
import { defaultIntake } from "./planGate";
```

Add the field to the `Meta` interface (after `runs: Run[];` near line 316):

```ts
  /**
   * Intent & Planning Gate (Epic A) sub-state. Absent on tasks created
   * before this feature → treat as `none` (gate inert). See
   * docs/superpowers/specs/2026-06-04-intent-planning-gate-design.md.
   */
  intake?: IntakeRecord | null;
```

Add helpers near the other exported meta mutators (after `updateRun`, using the same `withTaskLock` read-modify-write pattern):

```ts
/** Read the task's current intake record (null when absent / task missing). */
export function readIntake(dir: string): IntakeRecord | null {
  const meta = readMeta(dir);
  return meta?.intake ?? null;
}

/**
 * Patch the task's intake record under the per-task lock. Creates the
 * record from `defaultIntake()` on first write. Returns null when the
 * task's meta is missing.
 */
export function setIntake(dir: string, patch: Partial<IntakeRecord>): Promise<IntakeRecord | null> {
  return withTaskLock(dir, () => {
    const meta = readMeta(dir);
    if (!meta) return null;
    const base = meta.intake ?? defaultIntake();
    const next: IntakeRecord = { ...base, ...patch, updatedAt: new Date().toISOString() };
    meta.intake = next;
    writeMeta(dir, meta);
    return next;
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run libs/__tests__/metaIntake.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add libs/meta.ts libs/__tests__/metaIntake.test.ts
git commit -m "feat(plan-gate): intake field + readIntake/setIntake on task meta

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: guestAccess — allowlist plan + approve routes

**Files:**
- Modify: `libs/guestAccess.ts` (`RULES`)
- Test: `libs/__tests__/guestAccessPlan.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// libs/__tests__/guestAccessPlan.test.ts
import { describe, it, expect } from "vitest";
import { authorizeGuestRequest, type GuestScope } from "../guestAccess";

const tid = "t_20260604_001";
const grantsAll = {
  sendMessage: true, spawnAgent: true, answerPermission: true,
  commit: false, push: false, approvePlan: true,
};
const grantsNoApprove = { ...grantsAll, approvePlan: false };
const scope = (grants: any): GuestScope => ({ taskId: tid, grants });
const noop = () => true;

describe("guest plan-gate routes", () => {
  it("any task guest may GET the plan (view baseline)", () => {
    const r = authorizeGuestRequest("GET", `/api/tasks/${tid}/plan`, scope(grantsNoApprove), noop);
    expect(r.ok).toBe(true);
  });

  it("approve requires the approvePlan grant", () => {
    expect(authorizeGuestRequest("POST", `/api/tasks/${tid}/plan/approve`, scope(grantsAll), noop).ok).toBe(true);
    const denied = authorizeGuestRequest("POST", `/api/tasks/${tid}/plan/approve`, scope(grantsNoApprove), noop);
    expect(denied.ok).toBe(false);
    expect(denied.reason).toMatch(/approvePlan/);
  });

  it("approve on a different task is rejected", () => {
    const r = authorizeGuestRequest("POST", `/api/tasks/t_other_999/plan/approve`, scope(grantsAll), noop);
    expect(r.ok).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run libs/__tests__/guestAccessPlan.test.ts`
Expected: FAIL — both routes hit "not in guest allowlist".

- [ ] **Step 3: Write minimal implementation**

In `libs/guestAccess.ts`, add two rules to the `RULES` array (put the GET with the read baseline group, the POST with the send/drive group):

```ts
  // Plan-gate: view the intake plan (any task guest), approve it (grant).
  { method: "GET", pattern: ["tasks", ":tid", "plan"], grant: null },
  { method: "POST", pattern: ["tasks", ":tid", "plan", "approve"], grant: "approvePlan" },
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run libs/__tests__/guestAccessPlan.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add libs/guestAccess.ts libs/__tests__/guestAccessPlan.test.ts
git commit -m "feat(plan-gate): guest allowlist for GET plan + POST plan/approve

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: planGateLifecycle — resolve verdict on planner exit

**Files:**
- Create: `libs/planGateLifecycle.ts`
- Test: `libs/__tests__/planGateLifecycle.test.ts`

This module is called after a `planner` run exits while `intake.status === "planning"`.
It reads the planner's output, derives the verdict, and sets the next intake status —
auto-approving when the verdict is clear AND the submitter can self-approve.

- [ ] **Step 1: Write the failing test**

```ts
// libs/__tests__/planGateLifecycle.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "plgl-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); vi.restoreAllMocks(); });

import { computeNextIntakeStatus } from "../planGateLifecycle";

describe("computeNextIntakeStatus", () => {
  it("auto-approves a clear plan when the submitter can self-approve", () => {
    expect(computeNextIntakeStatus({ verdict: "clear", submitterCanApprove: true })).toBe("approved");
  });
  it("awaits approval for a clear plan when submitter cannot self-approve (guest w/o grant)", () => {
    expect(computeNextIntakeStatus({ verdict: "clear", submitterCanApprove: false })).toBe("awaiting-approval");
  });
  it("always awaits approval on needs-decision", () => {
    expect(computeNextIntakeStatus({ verdict: "needs-decision", submitterCanApprove: true })).toBe("awaiting-approval");
    expect(computeNextIntakeStatus({ verdict: "needs-decision", submitterCanApprove: false })).toBe("awaiting-approval");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run libs/__tests__/planGateLifecycle.test.ts`
Expected: FAIL — module/export missing.

- [ ] **Step 3: Write minimal implementation**

```ts
// libs/planGateLifecycle.ts
/**
 * Bridge-side orchestration that runs after a `planner` child exits while
 * a task's intake is in `planning`. Reads the planner's output, derives
 * the gate verdict, and advances intake → approved | awaiting-approval.
 * On auto-approval it continues the coordinator via the same resume path
 * the `continue` route uses, so coding proceeds with the plan injected.
 *
 * Lazy-required from runLifecycle.ts (matching the other post-exit gate
 * modules) to avoid an import cycle.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { readMeta, readIntake, setIntake } from "./meta";
import { canApprove, deriveGateVerdict, type GateVerdict, type IntakeStatus } from "./planGate";
import { readPlanGateConfig } from "./planGateConfig";

export function computeNextIntakeStatus(args: {
  verdict: GateVerdict;
  submitterCanApprove: boolean;
}): Extract<IntakeStatus, "approved" | "awaiting-approval"> {
  if (args.verdict === "clear" && args.submitterCanApprove) return "approved";
  return "awaiting-approval";
}

function readPlannerOutput(sessionsDir: string) {
  let intakeJson: unknown = null;
  const jsonPath = join(sessionsDir, "intake.json");
  if (existsSync(jsonPath)) {
    try { intakeJson = JSON.parse(readFileSync(jsonPath, "utf8")); } catch { intakeJson = null; }
  }
  let planMd: string | null = null;
  const planPath = join(sessionsDir, "plan.md");
  if (existsSync(planPath)) {
    try { planMd = readFileSync(planPath, "utf8"); } catch { planMd = null; }
  }
  return { intakeJson: intakeJson as any, planMd };
}

/**
 * Called on planner exit. No-op unless the task's intake is in `planning`.
 * Derives verdict, advances status, and (on auto-approval) continues the
 * coordinator. Fail-soft: any error parks intake at `error` so the
 * operator escape hatch shows, never throws into the lifecycle.
 */
export async function resolvePlanGateAfterPlanner(args: {
  taskId: string;
  sessionsDir: string;
  plannerSessionId: string;
}): Promise<void> {
  try {
    const intake = readIntake(args.sessionsDir);
    if (!intake || intake.status !== "planning") return;

    const derived = deriveGateVerdict(readPlannerOutput(args.sessionsDir));
    const submitter = intake.submittedBy;
    // Operator submitter (or guest with approvePlan recorded at submit time)
    // can self-approve. We persisted the capability as `submittedBy.kind`
    // + a flag is not stored; recompute conservatively: only the operator
    // auto-approves here. A guest-with-grant auto-approve is handled when
    // the guest hits the approve endpoint (explicit click) to keep the
    // capability check server-authoritative.
    const submitterCanApprove = submitter?.kind === "operator";

    const next = computeNextIntakeStatus({ verdict: derived.verdict, submitterCanApprove });
    await setIntake(args.sessionsDir, {
      status: next,
      verdict: derived.verdict,
      summary: derived.summary,
      questions: derived.questions,
      planSessionId: args.plannerSessionId,
      rounds: intake.rounds + 1,
      ...(next === "approved"
        ? { approvedBy: { kind: "operator", label: "auto (clear plan)", at: new Date().toISOString() } }
        : {}),
    });

    if (next === "approved") {
      await continueCoordinator(args.taskId, args.sessionsDir, derived.summary);
    }
  } catch (err) {
    console.error("[plan-gate] resolvePlanGateAfterPlanner failed:", err);
    try { await setIntake(args.sessionsDir, { status: "error" }); } catch { /* ignore */ }
  }
}

/** Resume the coordinator (or spawn one) with a plan-approved nudge. */
export async function continueCoordinator(
  taskId: string,
  sessionsDir: string,
  summary: string | null,
): Promise<void> {
  // Lazy-require to dodge the import cycle (coordinator → runLifecycle → here).
  const { resumeSessionWithLifecycle } = require("./resumeSession") as typeof import("./resumeSession");
  const { spawnCoordinatorForTask } = require("./coordinator") as typeof import("./coordinator");
  const { BRIDGE_ROOT } = require("./paths") as typeof import("./paths");

  const meta = readMeta(sessionsDir);
  if (!meta) return;
  const coordinator = meta.runs.find((r) => r.role === "coordinator");
  const msg = `Plan approved for bridge task ${taskId}. ${summary ? `Goal: ${summary} ` : ""}Read sessions/${taskId}/plan.md (the shared plan) and proceed with implementation — dispatch the coder(s). The bridge gate is now open.`;
  if (coordinator) {
    resumeSessionWithLifecycle({
      cwd: BRIDGE_ROOT,
      sessionId: coordinator.sessionId,
      message: msg,
      settings: { mode: "bypassPermissions" },
      context: `plan-gate-continue ${taskId}`,
    });
  } else {
    void spawnCoordinatorForTask({
      id: meta.taskId,
      title: meta.taskTitle,
      body: meta.taskBody,
      app: meta.taskApp ?? null,
      effort: meta.taskEffort ?? null,
    });
  }
}
```

> The reason auto-approval here is operator-only: the planner exit is a server event with no actor. A guest-with-grant "auto-approve on clear" is instead realized as a one-click in the share UI (Task 11/16) — the approve endpoint is the only place a guest's capability is checked server-side. This keeps the security check authoritative and avoids trusting a stored flag.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run libs/__tests__/planGateLifecycle.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add libs/planGateLifecycle.ts libs/__tests__/planGateLifecycle.test.ts
git commit -m "feat(plan-gate): resolve verdict on planner exit + auto-approve continuation

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 8: Wire planner-exit hook into runLifecycle

**Files:**
- Modify: `libs/runLifecycle.ts` (inside `wireRunLifecycle`'s exit handler)

No new unit test (integration covered by Task 9 + manual smoke); this is a wiring change
guarded behind a role check so it's a no-op for every non-planner run.

- [ ] **Step 1: Locate the exit handler**

In `libs/runLifecycle.ts`, find `wireRunLifecycle` (~line 920). It already special-cases
`run.role === "coordinator"`. Find where a finished run row has just been flipped to a
terminal status (the block around `finishedRun` / after the `done` write, ~line 1071).

- [ ] **Step 2: Add the planner hook**

Right after the run is confirmed finished (where `finishedRun` is known and its status is terminal), add:

```ts
    // Intent & Planning Gate: when a planner finishes while the task is
    // mid-planning, derive the verdict and advance the gate. Lazy-require
    // to avoid an import cycle (this module ← coordinator ← planGateLifecycle).
    if (finishedRun && finishedRun.role && finishedRun.role.toLowerCase().startsWith("planner")) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { resolvePlanGateAfterPlanner } = require("./planGateLifecycle") as typeof import("./planGateLifecycle");
        void resolvePlanGateAfterPlanner({
          taskId: basename(sessionsDir),
          sessionsDir,
          plannerSessionId: finishedRun.sessionId,
        });
      } catch (err) {
        console.error("[plan-gate] planner-exit hook failed (non-fatal):", err);
      }
    }
```

> Confirm `basename` is imported in `runLifecycle.ts` (it imports from `node:path` elsewhere); if not, add `import { basename } from "node:path";`. `sessionsDir` is already in scope in `wireRunLifecycle`.

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit`
Expected: no new errors.

- [ ] **Step 4: Commit**

```bash
git add libs/runLifecycle.ts
git commit -m "feat(plan-gate): call resolvePlanGateAfterPlanner on planner exit

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 9: Enforce the gate in the agents route

**Files:**
- Modify: `app/api/tasks/[id]/agents/route.ts`
- Test: `libs/__tests__/planGateEnforce.test.ts` (pure decision test — full route test is manual smoke)

- [ ] **Step 1: Write the failing test (decision-level)**

```ts
// libs/__tests__/planGateEnforce.test.ts
import { describe, it, expect } from "vitest";
import { evaluatePlanGate } from "../planGate";

// Mirrors the gateApplies computation the route performs.
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
});
```

- [ ] **Step 2: Run test to verify it passes the decision logic**

Run: `npx vitest run libs/__tests__/planGateEnforce.test.ts`
Expected: PASS (this validates the route's decision rule; the wiring below uses the same call).

- [ ] **Step 3: Wire the gate into the route**

In `app/api/tasks/[id]/agents/route.ts`, add imports:

```ts
import { evaluatePlanGate } from "@/libs/planGate";
import { readPlanGateConfig } from "@/libs/planGateConfig";
import { readIntake, setIntake } from "@/libs/meta";
import { spawnCoordinatorForTask } from "@/libs/coordinator";
```

After `meta` is loaded and `repo`/`role` are resolved (just before the resume branch, after `const actor = verifyRequestActor(req);` is available — note: `actor` is currently computed lower down near `effectiveGitForActor`; **hoist** that `const actor = verifyRequestActor(req);` to right after `meta` is confirmed so the gate can read it), insert:

```ts
  // ─── Intent & Planning Gate ─────────────────────────────────────────
  // Block mutating roles until the task's plan is approved. Non-mutating
  // roles (planner/reviewer/…) always pass so the gate can produce a plan.
  // Guests are always gated; the operator gate is configurable.
  {
    const cfg = readPlanGateConfig();
    const gateApplies = cfg.operatorEnabled || actor?.kind === "guest";
    const intake = readIntake(sessionsDir);
    const decision = evaluatePlanGate({
      role,
      intakeStatus: intake?.status ?? "none",
      gateApplies,
    });
    if (!decision.allowed) {
      if (decision.kickPlanning) {
        // No plan yet → open planning and ensure a coordinator is running
        // to drive the planner. Fire-and-forget; the contributor re-issues
        // (or the coordinator owns) the mutating spawn after approval.
        await setIntake(sessionsDir, {
          status: "planning",
          submittedBy: actor?.kind === "guest"
            ? { kind: "guest", label: "guest" }
            : { kind: "operator", label: "operator" },
        });
        if (!meta.runs.some((r) => r.role === "coordinator")) {
          void spawnCoordinatorForTask({
            id: meta.taskId,
            title: meta.taskTitle,
            body: meta.taskBody,
            app: meta.taskApp ?? null,
            effort: meta.taskEffort ?? null,
          });
        }
      }
      return NextResponse.json(
        {
          error: "plan-gate",
          reason: decision.reason,
          intakeStatus: intake?.status ?? "none",
          kickedPlanning: decision.kickPlanning,
        },
        { status: 423 },
      );
    }
  }
```

> Placement matters: the gate must run **before** worktree allocation / prompt build / spawn so a blocked call does no wasted work. Put it immediately after the `repoCwd` resolution and `actor` hoist, before the `if (mode === "resume")` branch.

- [ ] **Step 4: Typecheck**

Run: `npx tsc --noEmit`
Expected: no new errors. (Verify `actor` is in scope at the gate; the original `const actor = verifyRequestActor(req)` line lower down must be removed/relocated to avoid a redeclaration.)

- [ ] **Step 5: Commit**

```bash
git add app/api/tasks/[id]/agents/route.ts libs/__tests__/planGateEnforce.test.ts
git commit -m "feat(plan-gate): enforce gate at /agents (423 + kick planning for mutating roles)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 10: GET /api/tasks/[id]/plan

**Files:**
- Create: `app/api/tasks/[id]/plan/route.ts`

- [ ] **Step 1: Implement the route**

```ts
// app/api/tasks/[id]/plan/route.ts
import { NextResponse, type NextRequest } from "next/server";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { SESSIONS_DIR } from "@/libs/paths";
import { readMeta, readIntake } from "@/libs/meta";
import { isValidTaskId } from "@/libs/tasks";
import { badRequest } from "@/libs/validate";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: NextRequest, ctx: Ctx) {
  const { id } = await ctx.params;
  if (!isValidTaskId(id)) return badRequest("invalid task id");
  const sessionsDir = join(SESSIONS_DIR, id);
  const meta = readMeta(sessionsDir);
  if (!meta) return NextResponse.json({ error: "task not found" }, { status: 404 });

  const intake = readIntake(sessionsDir) ?? null;
  let planMarkdown: string | null = null;
  const planPath = join(sessionsDir, "plan.md");
  if (existsSync(planPath)) {
    try { planMarkdown = readFileSync(planPath, "utf8"); } catch { planMarkdown = null; }
  }
  return NextResponse.json({ intake, planMarkdown });
}
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: no new errors.

- [ ] **Step 3: Commit**

```bash
git add "app/api/tasks/[id]/plan/route.ts"
git commit -m "feat(plan-gate): GET task plan + intake projection

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 11: POST /api/tasks/[id]/plan/approve

**Files:**
- Create: `app/api/tasks/[id]/plan/approve/route.ts`

Actions: `approve` (default), `request-changes`, `reject`. Approve checks actor + grant,
records answers, flips to `approved` (idempotent), and continues the coordinator.

- [ ] **Step 1: Implement the route**

```ts
// app/api/tasks/[id]/plan/approve/route.ts
import { NextResponse, type NextRequest } from "next/server";
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { SESSIONS_DIR } from "@/libs/paths";
import { readMeta, readIntake, setIntake } from "@/libs/meta";
import { canApprove, type IntakeAnswer } from "@/libs/planGate";
import { continueCoordinator } from "@/libs/planGateLifecycle";
import { verifyRequestActor } from "@/libs/auth";
import { isValidTaskId } from "@/libs/tasks";
import { badRequest } from "@/libs/validate";
import { checkCsrf } from "@/libs/csrf";
import { checkRateLimit } from "@/libs/rateLimit";
import { getClientIp } from "@/libs/clientIp";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

interface ApproveBody {
  action?: "approve" | "request-changes" | "reject";
  answers?: Array<{ questionId: string; answer: string }>;
  note?: string;
}

export async function POST(req: NextRequest, ctx: Ctx) {
  const { id } = await ctx.params;
  if (!isValidTaskId(id)) return badRequest("invalid task id");

  const csrf = checkCsrf(req);
  if (csrf) return csrf;
  const denied = checkRateLimit("tasks:plan-approve", getClientIp(req.headers), 30, 60_000);
  if (denied) return NextResponse.json(denied.body, { status: denied.status, headers: denied.headers });

  const actor = verifyRequestActor(req);
  if (!actor) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const approverActor =
    actor.kind === "guest"
      ? { kind: "guest" as const, grants: { approvePlan: actor.grants.approvePlan } }
      : { kind: "operator" as const };
  if (!canApprove(approverActor)) {
    return NextResponse.json({ error: "not allowed to approve plans" }, { status: 403 });
  }

  let body: ApproveBody;
  try { body = (await req.json()) as ApproveBody; } catch { return badRequest("invalid JSON body"); }
  const action = body.action ?? "approve";

  const sessionsDir = join(SESSIONS_DIR, id);
  const meta = readMeta(sessionsDir);
  if (!meta) return NextResponse.json({ error: "task not found" }, { status: 404 });
  const intake = readIntake(sessionsDir);
  if (!intake || intake.status === "none") {
    return NextResponse.json({ error: "no plan to act on" }, { status: 409 });
  }

  const label = actor.kind === "guest" ? `guest:${actor.did.slice(0, 8)}` : "operator";
  const nowIso = new Date().toISOString();

  if (action === "reject") {
    const rec = await setIntake(sessionsDir, { status: "error", summary: (body.note ?? "rejected").slice(0, 500) });
    return NextResponse.json({ ok: true, intake: rec });
  }

  if (action === "request-changes") {
    const rec = await setIntake(sessionsDir, { status: "planning" });
    // Re-dispatch planning with the operator note via the continue path.
    await continueCoordinator(id, sessionsDir, `Re-plan: ${body.note ?? "operator requested changes"}`);
    return NextResponse.json({ ok: true, intake: rec });
  }

  // action === "approve". Idempotent: already approved → no-op 200.
  if (intake.status === "approved") {
    return NextResponse.json({ ok: true, intake, idempotent: true });
  }

  const answers: IntakeAnswer[] = Array.isArray(body.answers)
    ? body.answers
        .filter((a) => a && typeof a.questionId === "string" && typeof a.answer === "string")
        .map((a) => ({ questionId: a.questionId, answer: a.answer.slice(0, 4000), answeredBy: label, at: nowIso }))
    : [];

  // Append answers into plan.md so downstream coders (via loadSharedPlan) see them.
  if (answers.length > 0) {
    try {
      const block =
        "\n\n## Answers (operator/guest)\n" +
        answers.map((a) => `- **${a.questionId}** — ${a.answer}`).join("\n") + "\n";
      appendFileSync(join(sessionsDir, "plan.md"), block, "utf8");
    } catch (err) {
      console.warn("[plan-gate] failed to append answers to plan.md:", err);
    }
  }

  const rec = await setIntake(sessionsDir, {
    status: "approved",
    answers: [...intake.answers, ...answers],
    approvedBy: { kind: actor.kind, label, at: nowIso },
  });
  await continueCoordinator(id, sessionsDir, intake.summary);
  return NextResponse.json({ ok: true, intake: rec });
}
```

> Verify `checkCsrf` returns `NextResponse | null` (it's used elsewhere as a guard). If its signature differs, match the existing call sites in `app/api/tasks/[id]/runs/[sessionId]/commit/route.ts`.

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: no new errors.

- [ ] **Step 3: Commit**

```bash
git add "app/api/tasks/[id]/plan/approve/route.ts"
git commit -m "feat(plan-gate): POST plan/approve — approve/request-changes/reject + continue

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 12: Task creation sets intake → planning when gate applies

**Files:**
- Modify: `app/api/tasks/route.ts`

- [ ] **Step 1: Add the gate-init before the coordinator spawn**

In `app/api/tasks/route.ts`, add imports:

```ts
import { readPlanGateConfig } from "@/libs/planGateConfig";
import { setIntake } from "@/libs/meta";
import { verifyRequestActor } from "@/libs/auth";
```

Before the `spawnCoordinatorForTask` block (after the detect block, ~line 133), insert:

```ts
  // Intent & Planning Gate: if the gate applies to this creator, mark the
  // task as planning before the coordinator spawns. The coordinator is
  // mandated (prompt) to spawn the planner first; the bridge gate blocks
  // its mutating children until the plan is approved.
  try {
    const cfg = readPlanGateConfig();
    const actor = verifyRequestActor(req);
    const gateApplies = cfg.operatorEnabled || actor?.kind === "guest";
    if (gateApplies) {
      await setIntake(join(SESSIONS_DIR, task.id), {
        status: "planning",
        submittedBy: actor?.kind === "guest" ? { kind: "guest", label: "guest" } : { kind: "operator", label: "operator" },
      });
    }
  } catch (err) {
    console.warn("[plan-gate] task-create gate init failed (non-fatal):", err);
  }
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: no new errors.

- [ ] **Step 3: Commit**

```bash
git add app/api/tasks/route.ts
git commit -m "feat(plan-gate): mark new tasks as planning when the gate applies

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 13: Planner & coordinator prompt directives

**Files:**
- Modify: `prompts/playbooks/planner.md`
- Modify: `prompts/coordinator.md`
- Modify: `prompts/coordinator-playbook.md`

- [ ] **Step 1: Add the `intake.json` contract to the planner playbook**

In `prompts/playbooks/planner.md`, after the "### 5 · Write the plan file" section, add a new section:

````markdown
### 5b · Intent & Planning Gate — emit `intake.json`

When the bridge injected an `## Intake gate` block above, you are the **gate planner**.
In addition to `plan.md`, write `sessions/<task-id>/intake.json` with EXACTLY this shape:

```json
{
  "version": 1,
  "verdict": "clear",
  "summary": "<1-2 sentence restatement of the understood goal>",
  "questions": [],
  "planPath": "plan.md"
}
```

- Set `"verdict": "needs-decision"` and populate `questions` (each `{ "id", "text",
  "options"?, "recommended"? }`) when there is genuine ambiguity you cannot resolve from
  the task body + repo state. Otherwise `"clear"` with `"questions": []`.
- Keep `questions` to the few that actually block correct work — every question is a human
  round-trip. Always offer concrete options + a recommendation.
- This file is the gate's machine input. If you only write `plan.md`, the bridge falls
  back to parsing your `## Questions for the user` bullets — but the JSON is preferred.
````

- [ ] **Step 2: Add the gate directive to the coordinator prompt**

In `prompts/coordinator.md`, under "## Your job", add:

```markdown
## Intent & Planning Gate (when the task is mid-planning)

If `sessions/{{TASK_ID}}/meta.json` shows `intake.status` of `planning` /
`awaiting-approval`, the bridge has the **planning gate** open:

1. Your FIRST dispatch MUST be a `planner` (non-mutating — it passes the gate). Give it the
   task brief; it writes `plan.md` + `intake.json`.
2. Do **not** dispatch `coder` / `fixer` yet — the bridge returns **423** for mutating
   roles until the plan is approved. If you get a 423 with `error: "plan-gate"`, stop and
   finalize your turn with an `AWAITING DECISION` summary; the user approves in the UI and
   the bridge resumes you automatically.
3. Once resumed with "Plan approved", read `plan.md` and dispatch the coder(s) normally.
```

- [ ] **Step 3: Cross-reference in the playbook**

In `prompts/coordinator-playbook.md` §4 (NEEDS-DECISION handling), add a short pointer that
the planning gate uses the same surface: a planner `NEEDS-DECISION` lands the task at
`awaiting-approval`, and the operator's approval (not a coordinator re-dispatch) reopens it.

- [ ] **Step 4: Commit**

```bash
git add prompts/playbooks/planner.md prompts/coordinator.md prompts/coordinator-playbook.md
git commit -m "docs(prompts): planning-gate directives for planner + coordinator

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 14: Operator config — route + settings toggle

**Files:**
- Create: `app/api/settings/plan-gate/route.ts`
- Modify: `app/settings/*` (the settings page — add a toggle)

- [ ] **Step 1: Implement the config route (operator-only — proxy already gates `/api/settings`)**

```ts
// app/api/settings/plan-gate/route.ts
import { NextResponse, type NextRequest } from "next/server";
import { readPlanGateConfig, writePlanGateConfig } from "@/libs/planGateConfig";
import { checkCsrf } from "@/libs/csrf";
import { badRequest } from "@/libs/validate";

export const dynamic = "force-dynamic";

export function GET() {
  return NextResponse.json(readPlanGateConfig());
}

export async function PUT(req: NextRequest) {
  const csrf = checkCsrf(req);
  if (csrf) return csrf;
  let body: { operatorEnabled?: unknown; maxClarifyRounds?: unknown };
  try { body = await req.json(); } catch { return badRequest("invalid JSON body"); }
  const patch: { operatorEnabled?: boolean; maxClarifyRounds?: number } = {};
  if (typeof body.operatorEnabled === "boolean") patch.operatorEnabled = body.operatorEnabled;
  if (typeof body.maxClarifyRounds === "number") patch.maxClarifyRounds = body.maxClarifyRounds;
  return NextResponse.json(writePlanGateConfig(patch));
}
```

- [ ] **Step 2: Add a toggle to the settings page**

In the settings page (`app/settings/page.tsx` or its client component), add a section that
GETs `/api/settings/plan-gate` and PUTs on change. Minimal client snippet to model after
the page's existing fetch/save pattern:

```tsx
// inside the settings client component
const [gate, setGate] = useState<{ operatorEnabled: boolean; maxClarifyRounds: number } | null>(null);
useEffect(() => { fetch("/api/settings/plan-gate").then((r) => r.json()).then(setGate); }, []);
async function saveGate(patch: Partial<{ operatorEnabled: boolean; maxClarifyRounds: number }>) {
  const next = { ...gate!, ...patch };
  setGate(next);
  await fetch("/api/settings/plan-gate", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(patch),
  });
}
// render:
// <label><input type="checkbox" checked={gate?.operatorEnabled ?? true}
//   onChange={(e) => saveGate({ operatorEnabled: e.target.checked })} /> Planning Gate (operator)</label>
```

> Match the settings page's existing CSRF-token handling (it likely attaches a token header on mutating fetches — copy that pattern from a neighboring save call on the same page).

- [ ] **Step 3: Typecheck + commit**

Run: `npx tsc --noEmit`

```bash
git add "app/api/settings/plan-gate/route.ts" app/settings
git commit -m "feat(plan-gate): operator config route + settings toggle

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 15: Share dialog — `approvePlan` checkbox

**Files:**
- Modify: the share create/edit dialog component (find it under `app/_components/` — search for the component rendering the existing grant checkboxes `sendMessage` / `spawnAgent`).

- [ ] **Step 1: Add the checkbox + state**

Locate where the existing grants are rendered (grep the repo for `spawnAgent` in `app/`).
Add `approvePlan` to the grants state object's initial value (`approvePlan: false`) and a
checkbox next to the others:

```tsx
<label className="flex items-center gap-2">
  <input
    type="checkbox"
    checked={grants.approvePlan}
    onChange={(e) => setGrants((g) => ({ ...g, approvePlan: e.target.checked }))}
  />
  <span>Duyệt kế hoạch (approve plan)</span>
</label>
```

Ensure the create/update payload includes `approvePlan` (it flows through to
`shareStore.createShare` / `updateShare`, which now normalize it).

- [ ] **Step 2: Typecheck + commit**

Run: `npx tsc --noEmit`

```bash
git add app/_components
git commit -m "feat(plan-gate): approvePlan checkbox in the share dialog

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 16: PlanReviewCard — operator + guest surfaces

**Files:**
- Create: `app/_components/PlanReviewCard.tsx`
- Modify: operator task page (`app/tasks/[id]/*`) + guest share page (`app/share/[id]/[token]/page.tsx`) to render it.

- [ ] **Step 1: Build the component**

```tsx
// app/_components/PlanReviewCard.tsx
"use client";
import { useEffect, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

type IntakeStatus = "none" | "planning" | "awaiting-approval" | "approved" | "error";
interface Question { id: string; text: string; options?: string[]; recommended?: string }
interface Intake {
  status: IntakeStatus; verdict: "clear" | "needs-decision" | null;
  summary: string | null; questions: Question[];
}

export function PlanReviewCard({
  taskId, canApprove, csrfHeader,
}: { taskId: string; canApprove: boolean; csrfHeader?: Record<string, string> }) {
  const [intake, setIntake] = useState<Intake | null>(null);
  const [planMd, setPlanMd] = useState<string | null>(null);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  async function refresh() {
    const r = await fetch(`/api/tasks/${taskId}/plan`);
    if (!r.ok) return;
    const j = await r.json();
    setIntake(j.intake); setPlanMd(j.planMarkdown);
  }
  useEffect(() => {
    refresh();
    // Live updates: reuse the task events SSE.
    const es = new EventSource(`/api/tasks/${taskId}/events`);
    es.onmessage = () => refresh();
    return () => es.close();
  }, [taskId]);

  if (!intake || intake.status === "none" || intake.status === "approved") return null;

  async function act(action: "approve" | "request-changes" | "reject", note?: string) {
    setBusy(true);
    try {
      await fetch(`/api/tasks/${taskId}/plan/approve`, {
        method: "POST",
        headers: { "content-type": "application/json", ...(csrfHeader ?? {}) },
        body: JSON.stringify({
          action,
          note,
          answers: Object.entries(answers).map(([questionId, answer]) => ({ questionId, answer })),
        }),
      });
      await refresh();
    } finally { setBusy(false); }
  }

  return (
    <div className="rounded-lg border border-amber-500/40 bg-amber-500/5 p-4 space-y-3">
      <div className="flex items-center gap-2 text-sm font-medium">
        {intake.status === "planning" && <span>🧭 Đang lập kế hoạch…</span>}
        {intake.status === "awaiting-approval" && <span>⏳ Chờ duyệt kế hoạch</span>}
        {intake.status === "error" && <span>⚠️ Lập kế hoạch lỗi</span>}
      </div>

      {intake.status === "planning" && (
        <p className="text-sm text-muted-foreground">Planner đang chạy, sẽ có kế hoạch ngay.</p>
      )}

      {intake.status !== "planning" && planMd && (
        <div className="prose prose-sm dark:prose-invert max-w-none">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{planMd}</ReactMarkdown>
        </div>
      )}

      {intake.status === "awaiting-approval" && intake.questions.length > 0 && (
        <div className="space-y-2">
          {intake.questions.map((q) => (
            <div key={q.id} className="text-sm">
              <div className="font-medium">{q.text}</div>
              <input
                className="mt-1 w-full rounded border bg-background px-2 py-1"
                placeholder={q.recommended ? `Gợi ý: ${q.recommended}` : "Trả lời…"}
                value={answers[q.id] ?? ""}
                onChange={(e) => setAnswers((a) => ({ ...a, [q.id]: e.target.value }))}
              />
            </div>
          ))}
        </div>
      )}

      {canApprove ? (
        <div className="flex gap-2">
          {(intake.status === "awaiting-approval" || intake.status === "error") && (
            <button disabled={busy} onClick={() => act("approve")}
              className="rounded bg-emerald-600 px-3 py-1 text-sm text-white disabled:opacity-50">
              Duyệt &amp; code
            </button>
          )}
          <button disabled={busy} onClick={() => act("request-changes", "please refine")}
            className="rounded border px-3 py-1 text-sm disabled:opacity-50">
            Sửa hướng…
          </button>
          {intake.status === "awaiting-approval" && (
            <button disabled={busy} onClick={() => act("reject")}
              className="rounded border border-red-500/40 px-3 py-1 text-sm text-red-500 disabled:opacity-50">
              Từ chối
            </button>
          )}
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">Chờ chủ dự án duyệt kế hoạch.</p>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Render on the operator task page**

In the operator task detail page, render `<PlanReviewCard taskId={id} canApprove csrfHeader={...} />`
near the top of the task body (operator always `canApprove`). Use the page's existing CSRF
header helper for `csrfHeader`.

- [ ] **Step 3: Render on the guest share page**

In `app/share/[id]/[token]/page.tsx`, render `<PlanReviewCard taskId={taskId}
canApprove={share.grants.approvePlan} />`. The guest's cookie is sent automatically; no CSRF
header needed if the share POSTs are exempt — otherwise pass the guest CSRF token the page
already uses for `sendMessage` POSTs.

- [ ] **Step 4: Typecheck + commit**

Run: `npx tsc --noEmit`

```bash
git add app/_components/PlanReviewCard.tsx "app/tasks/[id]" "app/share/[id]/[token]/page.tsx"
git commit -m "feat(plan-gate): PlanReviewCard on operator + guest surfaces

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 17: Board badge

**Files:**
- Modify: the task card component used on the board (search `app/` for the component that renders task cards / sections).

- [ ] **Step 1: Add the badge**

Read `intake.status` from the task's meta (the board likely already loads meta per task —
if not, the `meta` route returns it). Render a small badge:

```tsx
{intakeStatus === "planning" && <span title="Đang lập kế hoạch" className="text-xs">🧭</span>}
{intakeStatus === "awaiting-approval" && <span title="Chờ duyệt plan" className="text-xs">⏳</span>}
```

- [ ] **Step 2: Typecheck + commit**

Run: `npx tsc --noEmit`

```bash
git add app
git commit -m "feat(plan-gate): board badge for planning / awaiting-approval

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 18: Full verification + smoke

**Files:** none (verification only)

- [ ] **Step 1: Full test suite**

Run: `npx vitest run`
Expected: all suites pass (new + existing — no regressions).

- [ ] **Step 2: Typecheck + lint**

Run: `npx tsc --noEmit && npx eslint .`
Expected: clean.

- [ ] **Step 3: Manual smoke (dev server)**

Run: `bun dev` (or `npm run dev`), then in the UI:
1. With the gate ON (default), create a task with a vague prompt → task shows 🧭, then ⏳ with a plan + questions.
2. Answer + **Duyệt & code** → coding proceeds; verify a `coder` run appears.
3. Create a task with a clear, explicit prompt as the operator → auto-approves (no ⏳), coder runs straight through.
4. Toggle the gate OFF in settings → operator task creation behaves as before (no 🧭/⏳).
5. Create a share with `approvePlan` OFF → open the share link, confirm the plan is read-only ("Chờ chủ dự án duyệt kế hoạch"). Turn `approvePlan` ON → the guest can approve.

- [ ] **Step 4: Final commit (if any smoke fixes)**

```bash
git add -A
git commit -m "fix(plan-gate): smoke-test follow-ups

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-review (completed by plan author)

**Spec coverage:** policy truth table → Tasks 1,7,11; gate enforcement → Tasks 1,9; intake
state machine → Tasks 5,7,11,12; planner output/derive → Tasks 2,13; approval + grants →
Tasks 4,6,11; config → Tasks 3,14; UI (operator/guest/board) → Tasks 15,16,17; lifecycle
hook → Tasks 7,8; error/edge (fail-open, error state, idempotent, round bound) → Tasks
2,3,7,11. All spec sections map to ≥1 task.

**Placeholder scan:** backend tasks (1–12) contain complete code. UI/prompt tasks (13–17)
provide concrete code + an explicit "find this existing component / match this pattern"
instruction because exact file paths for the settings page, share dialog, task card, and
task detail page must be confirmed in-repo at execution time (they were not all read during
planning). These are flagged inline, not silent TODOs.

**Type consistency:** `IntakeRecord` / `IntakeStatus` / `IntakeQuestion` / `IntakeAnswer`
defined in Task 1 are reused verbatim in Tasks 2,5,7,11. `evaluatePlanGate` signature
(`{ role, intakeStatus, gateApplies }`) matches its callers in Tasks 8/9. `setIntake`
returns `Promise<IntakeRecord | null>` consistently across Tasks 5,7,9,11,12.

**Known confirmation points for the implementer (not blockers):**
- The empty-meta factory name in Task 5 (`createInitialMeta`) — confirm against `libs/meta.ts`.
- `checkCsrf` signature/return — confirm against existing commit-route call sites.
- Exact file paths for settings page, share dialog, task card, task detail (Tasks 14–17).
