# Claude Bridge — Audit Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix all 25 findings from the 2026-08-26 multi-agent audit of the Claude Bridge repo, working outward from the trust machinery (quality gates) to structural debt.

**Architecture:** The audit's central finding is that this codebase already contains a correct implementation for nearly every defect found — the fix simply never propagated to sibling call sites. Tasks are therefore ordered so that each *pattern* is fixed once, then propagated, and where a pattern recurs three or more times it is extracted into a shared helper so the class of bug cannot return. No task invents a new approach when the repo already has one; the "reference implementation" is named explicitly in each task.

**Tech Stack:** TypeScript, Next.js 16.3.3 (App Router), React 19.2.8, Node 24, Bun (package manager + dev runner), Vitest 2, Tailwind v4.

**Spec:** The audit report — https://claude.ai/code/artifact/bb83761b-4ec3-498c-aacf-63cfa121ef06 — plus the finding text inlined verbatim in each task below. **Implementers must not need to open the artifact**; every task carries its own finding, reproduction, and reference implementation.

## Global Constraints

- **Never run `git checkout`, `git commit --amend`, `git push`, `git reset --hard`, or `git clean` in any task.** Implementers commit locally with `git add <paths> && git commit` only. Pushing is explicitly out of scope for this whole plan — the operator pushes by hand. (`CLAUDE.md`: the bridge owns git lifecycle; and this plan runs directly on `main` by operator decision.)
- **Work happens on `main`.** The operator chose this over a branch after being shown the risk. Do not create, switch, or delete branches.
- **`core.hooksPath` for this repo points at another repo** (`edusoft-lms-bridge/.git/hooks`) and an auto-commit+push to `origin/main` was observed during this session. If a commit you did not create appears, stop and report it — do not attempt to undo it.
- **TDD is mandatory.** Every task writes a failing test first, watches it fail for the stated reason, then implements. A task whose test passes before the implementation is a broken test — fix the test, don't proceed.
- **Test runner:** `bun run test` (all), or `bunx vitest run <file>` for one file. Tests live in `libs/__tests__/`.
- **Verification before commit:** `bun run typecheck` must be clean. `bun run lint` must report **0 errors** (4 pre-existing warnings are acceptable and must not grow).
- **Do not "fix" the 4 pre-existing lint warnings** unless a task names them. They are in `MessageComposer.tsx` (2× `exhaustive-deps`) and 2× `no-unused-vars` with the project's deliberate `^_` ignore convention.
- **Never widen a `claude -p` child's permissions.** Several tasks narrow them; none may broaden them.
- **Do not add code comments.** The operator directed a full comment strip partway through this plan, and it was executed: ~7,345 comments removed across 401 files, leaving 59 toolchain directives (`eslint-disable`, `turbopackIgnore`, `@ts-expect-error`) which are machine-read instructions rather than documentation. Write code that reads clearly on its own — names, small functions, explicit control flow — rather than reintroducing prose the operator has decided against. **This constraint replaces the earlier one that asked implementers to preserve comment voice; if a brief generated before that change still says "preserve comment density", this line wins.**
- **Do not reformat, re-sort imports, or restyle code you are not changing.** Diffs must stay reviewable.

---

## Phase A — Make the trust machinery fail closed

The bridge's entire value is that agent output can be trusted. Today four of five gates silently report "pass" when the gate itself crashes, and the confidence score awards full marks for a gate that never ran. This phase is first because every later task's correctness is judged by this machinery.

### Task 1: Gates block instead of silently passing when they crash

**Finding (C2, Critical):** `runVerifyChainGate` treats an exception from its checker as an inconclusive failure — it blocks the commit and calls `escalateGateBlock`. The other four gates (`runPreflightGate`, `runClaimGate`, `runStyleCriticGate`, `runSemanticVerifierGate`) `catch` the exception, log it, set their result to `null`, and then hit a `if (!result || …) return "proceed"` line — making "the gate crashed" indistinguishable from "the gate ran and passed". `runAgentGate` (`libs/qualityGate.ts:172-219`) calls `loadHouseRules`, `ensureFreshSymbolIndex`, `buildChildPrompt` and `appendRun` with no try/catch, so a throw in any dispatched lens rejects the whole panel — and the coder's diff, never semantically judged, commits/pushes/merges exactly like a pass, with only a server log line.

**Files:**
- Modify: `libs/runLifecycle.ts` — `runPreflightGate` (301-386), `runClaimGate` (395-461), `runStyleCriticGate` (471-548), `runSemanticVerifierGate` (557-633)
- Modify: `libs/meta.ts` — widen the gate-result verdict unions with `"crashed"`
- Test: `libs/__tests__/runLifecycle.test.ts`

**Interfaces:**
- Consumes: `escalateGateBlock({ taskId, sessionsDir, gate, reason, retryScheduled })` from `libs/gateEscalation.ts:71`. `EscalationGate = "verify" | "preflight" | "claim" | "style" | "semantic"` — all four values you need already exist.
- Produces: nothing new. Gate signatures stay `(ctx: PostExitContext) => Promise<GateOutcome>` where `GateOutcome = "proceed" | "blocked"` (`libs/runLifecycle.ts:172`).

**Reference implementation — copy this shape.** `runVerifyChainGate` at `libs/runLifecycle.ts:192-258` is the correct pattern:

```ts
let verifyResult: RunVerify | null = null;
let verifyCrashed = false;
try {
  verifyResult = await vc.runVerifyChain({ ... });
} catch (err) {
  logError("verify", "chain crashed", err, { tag: t });
  verifyResult = null;
  verifyCrashed = true;
}

// ... later, before the normal verdict handling:
if (verifyCrashed) {
  logWarn("verify", "chain crashed — blocking auto-commit (operator must verify manually)", { tag: t });
  await updateRun(
    dir,
    run.sessionId,
    { status: "done", endedAt: new Date().toISOString() },
    (r) => r.status === "running",
  );
  await escalateGateBlock({
    taskId: tid,
    sessionsDir: dir,
    gate: "verify",
    reason: "verify chain crashed — inconclusive",
    retryScheduled: false,
  });
  return "blocked";
}
```

Note the three parts that matter: (1) a `crashed` flag set in the `catch`, (2) the run is still flipped to `done` so the UI doesn't hang on `running`, guarded by the `(r) => r.status === "running"` precondition, and (3) `escalateGateBlock` with `retryScheduled: false`, then `return "blocked"`.

**Additional requirement — persist the crash (this feeds Task 2).** Each crash branch must also record an explicit `"crashed"` verdict on the run via the existing `attachGateResult(dir, run.sessionId, "<gate>", { verdict: "crashed" })`, using the same call shape as `runVerifyChainGate`'s `attachGateResult(dir, run.sessionId, "verify", finalVerify)`.

Why explicit rather than leaving the field `undefined`: `run.semanticVerifier` is *legitimately* `undefined` whenever an app opted out (`runSemanticVerifierGate` returns early on `!semanticVerifierEnabled(app)`), so absence is ambiguous and cannot be scored. A recorded `"crashed"` verdict is unambiguous, and it also surfaces the crash in `meta.json` for the UI instead of burying it in a server log.

This requires adding `"crashed"` to the verdict unions on `RunVerifier`, `RunStyleCritic` and `RunSemanticVerifier` (and the preflight result type if it carries one) in `libs/meta.ts`. Widen the union; do not cast. Run `bun run typecheck` after widening and give every resulting exhaustiveness error an explicit `"crashed"` branch — treat it as the failure state it is, never folding it into the pass branch.

- [ ] **Step 1: Write the four failing tests**

Add to `libs/__tests__/runLifecycle.test.ts`. Read the existing "verify-crash branch escalates" test near line 577 first and mirror its harness exactly — the same mocks, the same `escalateGateBlock` spy. Write one test per gate:

```ts
it("preflight crash blocks the commit and escalates", async () => {
  // Arrange the app so the preflight gate actually runs, then force
  // the checker to throw.
  preflightMock.runPreflight.mockImplementation(() => {
    throw new Error("boom");
  });

  await runPostExitGates(ctx);

  expect(escalateGateBlockSpy).toHaveBeenCalledWith(
    expect.objectContaining({ gate: "preflight", retryScheduled: false }),
  );
  expect(autoCommitAndPushSpy).not.toHaveBeenCalled();
});
```

Repeat for `gate: "claim"` (throw from `vfn.runVerifier`), `gate: "style"` (throw from `sc.runStyleCritic`), and `gate: "semantic"` (throw from `sv.runSemanticVerifier`). The `autoCommitAndPushSpy` assertion is the load-bearing one: it proves the crash actually stopped the commit rather than merely logging.

Add one more test for the persisted marker, since Task 2 scores it:

```ts
it("records an explicit crashed verdict so the score can see it", async () => {
  semanticMock.runSemanticVerifier.mockImplementation(() => {
    throw new Error("panel exploded");
  });

  await runPostExitGates(ctx);

  const meta = readMeta(dir);
  const run = meta!.runs.find((r) => r.sessionId === ctx.run.sessionId);
  expect(run?.semanticVerifier?.verdict).toBe("crashed");
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bunx vitest run libs/__tests__/runLifecycle.test.ts`
Expected: 4 FAIL. Each fails because `escalateGateBlock` was never called — the gate returned `"proceed"` and the run continued to auto-commit.

- [ ] **Step 3: Add the crash flag and blocking branch to all four gates**

For each of the four gates, add a `<name>Crashed` boolean beside the existing result variable, set it to `true` in the existing `catch`, and insert the blocking branch *before* the gate's existing "no result → proceed" line. The four `catch` blocks to amend are at `libs/runLifecycle.ts:334-336` (preflight), `:409-412` (claim), `:495-498` (style), `:578-581` (semantic).

Preflight — the existing early return is `if (!preflightResult || preflightResult.verdict !== "fail") return "proceed";` at line 337. Insert above it:

```ts
if (preflightCrashed) {
  logWarn("preflight", "crashed — blocking auto-commit (operator must verify manually)", { tag: t });
  await updateRun(
    dir,
    run.sessionId,
    { status: "done", endedAt: new Date().toISOString() },
    (r) => r.status === "running",
  );
  await escalateGateBlock({
    taskId: tid,
    sessionsDir: dir,
    gate: "preflight",
    reason: "preflight crashed — inconclusive",
    retryScheduled: false,
  });
  return "blocked";
}
```

Apply the identical shape to the other three, changing only the variable name, the `logWarn` scope string, the `gate` value (`"claim"` / `"style"` / `"semantic"`) and the reason text. Place each branch immediately after the `try/catch` and before any code that reads the result.

In each branch, before the `escalateGateBlock` call, persist the crash marker:

```ts
  await attachGateResult(dir, run.sessionId, "semantic", { verdict: "crashed" });
```

using that gate's own key and result type. Match `runVerifyChainGate`'s existing `attachGateResult(dir, run.sessionId, "verify", finalVerify)` call for the exact parameter order.

**Do not** add the `updateRun` call more than once per gate — if the gate already flips status further down, keep only the branch's own flip and let the `return "blocked"` skip the rest.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bunx vitest run libs/__tests__/runLifecycle.test.ts`
Expected: PASS, including the pre-existing verify-crash test (regression check).

- [ ] **Step 5: Full verification**

Run: `bun run typecheck && bun run lint && bun run test`
Expected: typecheck clean, 0 lint errors, all tests pass.

- [ ] **Step 6: Commit**

```bash
git add libs/runLifecycle.ts libs/__tests__/runLifecycle.test.ts
git commit -m "fix(gates): block and escalate when preflight/claim/style/semantic crash

All four gates caught their checker's exception, set the result to null,
and fell through to \"proceed\" — making an infra crash indistinguishable
from a pass. Mirrors the existing runVerifyChainGate crash branch."
```

---

### Task 2: Confidence score penalizes a gate that never produced a result

**Finding (C3, Critical):** `computeConfidence`'s own docstring (`libs/confidenceScore.ts:36-40`) states: *"Gates that didn't run (`undefined`) contribute 0 unless their absence itself is a missing-check signal (verifier / semantic)"*. The implementation never does this — `if (v) {…}` and `if (sv) {…}` only apply a penalty when the field is *present* (including the explicit `"skipped"` object: −5 / −8). When `undefined`, both contribute exactly 0, identical to a clean pass. Since these fields only stay `undefined` when the gate crashed (Task 1) or was opted out, a run that hit two independent judge-agent infra failures can still score 100/`high` and skip the operator-review hold.

**Files:**
- Modify: `libs/confidenceScore.ts:41-79`
- Test: `libs/__tests__/confidenceScore.test.ts`

**Interfaces:**
- Consumes: `Run` from `libs/meta.ts`; `run.verifier?: RunVerifier`, `run.semanticVerifier?: RunSemanticVerifier`.
- Produces: `computeConfidence(run: Run): ConfidenceResult` — signature unchanged. The `ConfidenceBreakdown` keys stay `{ verify, verifier, style, semantic, panelSplit }`.

**Design ruling carried into this task (decided during pre-flight; Task 1 implements the other half):** do **not** penalize an `undefined` result. `run.semanticVerifier` is legitimately `undefined` whenever an app opted out of semantic verification, so absence is ambiguous and penalizing it would permanently depress the score of every opted-out app. Task 1 now records an explicit `{ verdict: "crashed" }` marker when a gate throws; this task penalizes **that marker**, which is unambiguous.

Penalties, chosen against the existing bands (`bandFor`: `>= 80` → `high`, `>= 60` → `medium`, `libs/confidenceScore.ts:30-34`):

- `verifier.verdict === "crashed"` → −15 (vs −5 for an explicit `"skipped"`)
- `semanticVerifier.verdict === "crashed"` → −20 (vs −8 for an explicit `"skipped"`)
- `styleCritic.verdict === "crashed"` → −10

A single crashed judge gate therefore lands at 85 or 80 — still `high`, which is deliberate: one infra blip on an otherwise clean run is not a reason to hold. **Two** crashed gates land at 65 → `medium`, below the default hold threshold, which is the outcome the finding demands.

- [ ] **Step 1: Write the failing test**

```ts
it("penalizes a crashed gate far more than an explicit skip", () => {
  const base = makeRun({ verify: { passed: true } });

  const skipped = computeConfidence({
    ...base,
    verifier: { verdict: "skipped" },
    semanticVerifier: { verdict: "skipped" },
  });
  const crashed = computeConfidence({
    ...base,
    verifier: { verdict: "crashed" },
    semanticVerifier: { verdict: "crashed" },
  });

  expect(crashed.score).toBeLessThan(skipped.score);
});

it("a run whose two judge gates both crashed is not high confidence", () => {
  const crashed = computeConfidence(
    makeRun({
      verify: { passed: true },
      verifier: { verdict: "crashed" },
      semanticVerifier: { verdict: "crashed" },
    }),
  );
  expect(crashed.band).not.toBe("high");
});

it("an opted-out semantic gate (undefined) is still unpenalized", () => {
  const optedOut = computeConfidence(
    makeRun({ verify: { passed: true }, verifier: { verdict: "ok" } }),
  );
  expect(optedOut.breakdown.semantic).toBe(0);
});
```

The third test is the guard against over-correcting — it must stay passing. Use the file's existing `makeRun` helper if present; otherwise build the `Run` literal the way neighbouring tests do, and use the real `"ok"`/pass verdict spelling from the type rather than inventing one.

Read `libs/__tests__/confidenceScore.test.ts:60-67` first — it currently asserts the all-`undefined` case scores 100. That assertion stays **correct** under this ruling and must not be changed.

- [ ] **Step 2: Run the test to verify it fails**

Run: `bunx vitest run libs/__tests__/confidenceScore.test.ts`
Expected: FAIL — `crashed.score` equals `skipped.score` minus nothing, because `"crashed"` matches none of the existing verdict branches and contributes 0.

- [ ] **Step 3: Implement**

In `libs/confidenceScore.ts`, add a `"crashed"` branch to each of the three gate blocks, ordered before the milder verdicts so it cannot be shadowed:

```ts
  // Claim-vs-diff verifier (honesty check).
  const v = run.verifier;
  if (v) {
    if (v.verdict === "crashed") b.verifier -= CRASHED_VERIFIER_PENALTY;
    else if (v.verdict === "drift") b.verifier -= 10;
    else if (v.verdict === "broken") b.verifier -= 25;
    else if (v.verdict === "skipped") b.verifier -= 5;
    const unmatched = Array.isArray(v.unmatchedClaims) ? v.unmatchedClaims.length : 0;
    b.verifier -= Math.min(UNMATCHED_CLAIM_CAP, unmatched * UNMATCHED_CLAIM_PENALTY);
  }
```

Same shape for `run.styleCritic` (`CRASHED_STYLE_PENALTY`) and `run.semanticVerifier` (`CRASHED_SEMANTIC_PENALTY`). Leave the `undefined` path exactly as it is — no `else` branch.

Declare the constants beside the existing `UNMATCHED_CLAIM_*` constants:

```ts
/** A gate that threw produced NO judgement at all — strictly worse than
 *  an explicit `"skipped"`, which is a recorded decision. Two crashed
 *  gates must drop the run out of the `high` band so it is held for
 *  review; one alone should not (audit C2/C3). See the crash branches
 *  in libs/runLifecycle.ts, which write this verdict. */
const CRASHED_VERIFIER_PENALTY = 15;
const CRASHED_SEMANTIC_PENALTY = 20;
const CRASHED_STYLE_PENALTY = 10;
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bunx vitest run libs/__tests__/confidenceScore.test.ts`
Expected: PASS.

- [ ] **Step 5: Check for downstream fallout**

Run: `bun run test`
Expected: all pass. `libs/__tests__/confidenceWorktree.test.ts` exercises the hold path and may assert specific scores — if it fails, the assertion needs updating to the new baseline, not the penalty reverting. Report any such change in your report file.

- [ ] **Step 6: Commit**

```bash
git add libs/confidenceScore.ts libs/__tests__/confidenceScore.test.ts
git commit -m "fix(confidence): score a crashed gate as the failure it is

A crashed judge gate left its field untouched and contributed 0 —
identical to a clean pass — so a run that hit two judge-infra failures
could still reach 100/high and skip the operator review hold. Task 1
now records an explicit crashed verdict; this scores it."
```

**Also correct the docstring.** `libs/confidenceScore.ts:36-40` currently claims absence itself is the missing-check signal. Under this ruling it is not — an explicit `"crashed"` verdict is. Rewrite those lines to describe what the code now actually does, so the next reader is not sent down the same wrong path this finding came from.

---

### Task 3: Plan gate fails closed when the planner produced no artifact

**Finding (H5, High):** `resolvePlanGateAfterPlanner` (`libs/planGateLifecycle.ts:44-86`) fires on a clean exit (`code === 0`) of a `planner*` role. If that planner exits 0 without writing `intake.json` or a non-empty `plan.md`, `deriveGateVerdict` (`libs/planGate.ts:185-203`) "fails open" to `{verdict:"clear", questions:[]}`. For an operator-submitted task, `computeNextIntakeStatus({verdict:"clear", submitterCanApprove:true})` returns `"approved"`, stamped `approvedBy: {kind:"operator", label:"auto (clear plan)"}` — indistinguishable in the UI from a genuinely reviewed plan — and the coordinator is told to proceed with implementation though no plan content exists. "Clean exit, forgot the contract file" is a failure mode this codebase has retry/escalation machinery for elsewhere.

**Files:**
- Modify: `libs/planGate.ts:185-203` (`deriveGateVerdict`), `libs/planGateLifecycle.ts:44-86` (`resolvePlanGateAfterPlanner`)
- Test: `libs/__tests__/planGateVerdict.test.ts`, `libs/__tests__/planGateLifecycle.test.ts`

**Interfaces:**
- Consumes: `computeNextIntakeStatus({ verdict, submitterCanApprove })` from `libs/planGateLifecycle.ts:16-22`.
- Produces: `deriveGateVerdict` gains a third possible verdict value, `"unknown"`, alongside the existing ones. Every consumer of the verdict must handle it. Search for `deriveGateVerdict(` and for the verdict union's declaration before implementing, and update the union type — do not cast.

**Ruling carried into this task:** distinguish *"the planner explicitly found zero open questions"* from *"no artifact was produced"*. The first stays `"clear"`. The second becomes `"unknown"` and routes to `awaiting-approval` (a human looks at it), never to a synthetic `approved`.

- [ ] **Step 1: Write the failing tests**

In `libs/__tests__/planGateVerdict.test.ts` — note that line 48-51 currently asserts *"fails open to clear when nothing is parseable"*, which is the bug. Replace that test:

```ts
it("returns unknown (not clear) when no artifact was produced at all", () => {
  const v = deriveGateVerdict({ intake: null, planMd: "" });
  expect(v.verdict).toBe("unknown");
});

it("still returns clear when the planner explicitly recorded zero questions", () => {
  const v = deriveGateVerdict({ intake: { questions: [] }, planMd: "# Plan\n\nProceed." });
  expect(v.verdict).toBe("clear");
});
```

Match `deriveGateVerdict`'s real parameter shape — read the function before writing the test and use its actual signature.

In `libs/__tests__/planGateLifecycle.test.ts`:

```ts
it("does not auto-approve an operator task when the planner wrote nothing", () => {
  expect(
    computeNextIntakeStatus({ verdict: "unknown", submitterCanApprove: true }),
  ).toBe("awaiting-approval");
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bunx vitest run libs/__tests__/planGateVerdict.test.ts libs/__tests__/planGateLifecycle.test.ts`
Expected: FAIL — `deriveGateVerdict` returns `"clear"` for the empty case, and `computeNextIntakeStatus` does not accept `"unknown"`.

- [ ] **Step 3: Implement**

In `libs/planGate.ts`, add `"unknown"` to the verdict union and change the fail-open fallback in `deriveGateVerdict` so that the "nothing parseable" path returns `"unknown"`. Keep the genuine "parsed, zero questions" path returning `"clear"`. Add a comment naming the distinction:

```ts
  // A planner that exits 0 without writing intake.json OR a non-empty
  // plan.md violated its contract — that is NOT evidence of "no open
  // questions". Failing open here auto-approved tasks with no plan at
  // all (audit H5). Route it to a human instead.
  return { verdict: "unknown", questions: [] };
```

In `libs/planGateLifecycle.ts`, make `computeNextIntakeStatus` map `"unknown"` to `"awaiting-approval"` regardless of `submitterCanApprove`. Then find every other consumer of the verdict union (grep for the union type name) and give each an explicit `"unknown"` branch — a `switch` without a case for it must not fall through to the `"clear"` behaviour.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bunx vitest run libs/__tests__/planGateVerdict.test.ts libs/__tests__/planGateLifecycle.test.ts`
Expected: PASS.

- [ ] **Step 5: Full verification**

Run: `bun run typecheck && bun run lint && bun run test`
Expected: typecheck is the important one here — it will surface any consumer of the verdict union you missed.

- [ ] **Step 6: Commit**

```bash
git add libs/planGate.ts libs/planGateLifecycle.ts libs/__tests__/planGateVerdict.test.ts libs/__tests__/planGateLifecycle.test.ts
git commit -m "fix(plan-gate): fail closed when the planner produced no artifact

A planner exiting 0 without intake.json or plan.md was read as \"no open
questions\" and auto-approved, stamped indistinguishably from a reviewed
plan. It now resolves to unknown -> awaiting-approval."
```

---

## Phase B — Represent operator intent in the run state machine

### Task 4: Add a `cancelled` run status so Stop is not retried

**Finding (C1, Critical):** `RUN_STATUSES` (`libs/runStatus.ts:10-16`) is `queued | running | done | failed | stale` — there is no state for "a human stopped this". Both kill routes and the Telegram `/kill` command flip a manually-stopped run to `status:"failed"`, identical to a crash. `failRun` (`libs/runLifecycle.ts:1112-1130`) then calls `tryAutoRetry(exitCode)` **unconditionally**, outside its own try/catch and regardless of whether its `updateRun` precondition applied. `maybeScheduleRetry` gates only on `isEligibleForRetry`, which has no kill awareness — `looksKilledByUser` (`libs/childRetry.ts:229`) is used exactly once, at `:311`, to decorate the retry's context message, never to gate eligibility. Result: the operator clicks Stop, and the bridge spawns `claude --resume <same-sid>` with a "keep going" message, undoing the Stop and burning another turn.

**Files:**
- Modify: `libs/runStatus.ts:10-16`, `libs/childRetry.ts` (`isEligibleForRetry`), `app/api/sessions/[sessionId]/kill/route.ts:64-69`, `app/api/tasks/[id]/runs/[sessionId]/kill/route.ts:49-54`, `libs/telegramCommands.ts` (the `/kill` handler)
- Test: `libs/__tests__/childRetry.test.ts`

**Interfaces:**
- Produces: `RunStatus` gains `"cancelled"`. **This is a breaking widening** — every exhaustive `switch` over `RunStatus` and every UI status badge must handle it. `libs/runStatus.ts` is imported by both server and client bundles by design (see its header comment); keep it dependency-free.
- Consumes: `isEligibleForRetry(taskId, failedRun)` from `libs/childRetry.ts`.

**Ruling carried into this task:** name the status `cancelled`, not `killed` — the reaper already uses `stale` for "died without telling us", and `cancelled` reads unambiguously as an intentional human act in the UI.

- [ ] **Step 1: Write the failing test**

Add to `libs/__tests__/childRetry.test.ts` (which today only covers `readFailedSessionContext`):

```ts
it("does not schedule a retry for a run the operator cancelled", () => {
  const run = makeRun({ status: "cancelled", role: "coder", parentSessionId: "parent-1" });
  const result = isEligibleForRetry("t_20260826_001", run);
  expect("nextAttempt" in result).toBe(false);
});

it("still schedules a retry for a run that genuinely failed", () => {
  const run = makeRun({ status: "failed", role: "coder", parentSessionId: "parent-1" });
  const result = isEligibleForRetry("t_20260826_001", run);
  expect("nextAttempt" in result).toBe(true);
});
```

Build `makeRun` to produce a `Run` that the existing eligibility rules would otherwise accept (it needs a parent and a retry budget) — read `isEligibleForRetry` first and satisfy its preconditions, otherwise the second test passes for the wrong reason.

- [ ] **Step 2: Run the test to verify it fails**

Run: `bunx vitest run libs/__tests__/childRetry.test.ts`
Expected: FAIL — `"cancelled"` is not assignable to `RunStatus`, so this fails at typecheck/compile before it fails at runtime. That is the correct first failure.

- [ ] **Step 3: Add the status**

`libs/runStatus.ts`:

```ts
export const RUN_STATUSES = [
  "queued",
  "running",
  "done",
  "failed",
  // Terminal, and deliberately distinct from `failed`: a human stopped
  // this run. Retry eligibility short-circuits on it so the Stop button
  // is not silently undone by auto-retry (audit C1).
  "cancelled",
  "stale",
] as const;
```

- [ ] **Step 4: Gate retry eligibility on it**

In `libs/childRetry.ts`, at the top of `isEligibleForRetry`, before any budget arithmetic:

```ts
  // A run the operator cancelled must never be resumed — that would
  // undo an explicit human decision and spend another turn on the path
  // they just rejected. Mirrors the existing speculativeOutcome ===
  // "lost" short-circuit below.
  if (failedRun.status === "cancelled") return { reason: "cancelled by operator" };
```

Match the exact shape of the function's existing ineligible return value — read the other early returns and copy their form.

- [ ] **Step 5: Make the kill paths set it**

In `app/api/sessions/[sessionId]/kill/route.ts:64-69` and `app/api/tasks/[id]/runs/[sessionId]/kill/route.ts:49-54`, change `{ status: "failed", … }` to `{ status: "cancelled", … }`. **Keep the existing `(r) => r.status === "running"` precondition unchanged.**

Then find the Telegram `/kill` handler in `libs/telegramCommands.ts` (grep for `"kill"`) and make the same change if it writes a status directly.

- [ ] **Step 6: Handle the new status everywhere it must be handled**

Run `bun run typecheck` and fix every error it reports. Then grep the UI for status handling that typecheck cannot catch (string comparisons rather than exhaustive switches):

Run: `grep -rn '"failed"' app/_components app/tasks libs/client | grep -v node_modules`

Anywhere a run is rendered as failed/errored, `cancelled` needs a branch. Render it with neutral, not alarming, styling — it is an expected outcome, not an error. Reuse whatever muted/secondary token the surrounding component already uses; do not introduce a new colour.

- [ ] **Step 7: Run the tests to verify they pass**

Run: `bunx vitest run libs/__tests__/childRetry.test.ts && bun run typecheck && bun run test`
Expected: all pass.

- [ ] **Step 8: Commit**

```bash
git add libs/runStatus.ts libs/childRetry.ts app/api/sessions/\[sessionId\]/kill/route.ts "app/api/tasks/[id]/runs/[sessionId]/kill/route.ts" libs/telegramCommands.ts libs/__tests__/childRetry.test.ts
git add -u app libs
git commit -m "feat(lifecycle): add cancelled run status so Stop is not auto-retried

Kill routes flipped runs to failed, indistinguishable from a crash, and
failRun calls tryAutoRetry unconditionally — so clicking Stop spawned a
--resume of the very session the operator had just stopped."
```

---

## Phase C — Close the internal-token and guest-scope holes

This phase is prioritised above the mechanical propagation work because this operator's bridge has a live public URL (`publicUrl: https://claude.stop1love1.online` in `~/.claude/bridge.json`), which turns two LAN-scoped weaknesses into internet-scoped ones.

### Task 5: Derive same-host from the socket, and require a ticket for the PTY WebSocket

**Finding (C5 Critical + H2 High):** Two related holes in the internal-token bypass.

*H2:* `proxy.ts:179-191` derives `isLoopbackHost` from the request's `Host` header and sets `viaProxy = !isLoopbackHost || <forwarding headers present>`. A non-browser client can send `Host: localhost` with no forwarding headers to make `viaProxy` false, unlocking the internal-token bypass on every route. `libs/setupToken.ts:3-8` documents this exact weakness in its own header comment — *"a stranger on the LAN can send `Host: localhost` and pass the check whenever the bridge is bound to a non-loopback interface"* — and `/api/auth/setup` was migrated off Host-based checks for that reason. `proxy.ts` still relies on the spoofable signal.

*C5:* The PTY WebSocket upgrade is handled by a raw `server.on("upgrade")` listener in `scripts/bridge-http-server.ts` that Next middleware never touches, so it has no `viaProxy` equivalent at all. It calls `verifyRequestAuthOrInternal()` directly at `:239`. The token is injected into every spawned child's env (`libs/spawn.ts:332`) and the server binds `0.0.0.0` by default (`:190`). Anyone holding the token gets an interactive `node-pty` shell in the target app's directory.

**Files:**
- Modify: `scripts/bridge-http-server.ts:239-267`, `proxy.ts:164-199`
- Test: `libs/__tests__/ptyWsTickets.test.ts` (extend), new `libs/__tests__/proxyInternalToken.test.ts` if the gate logic can be extracted

**Interfaces:**
- Consumes: `consumePtyWsTicket(raw)` from `libs/ptyWsTickets.ts` (already used at `scripts/bridge-http-server.ts:254`); `POST /api/apps/pty-ws-ticket` already mints tickets.
- Produces: no new exports.

**Ruling carried into this task:** the PTY path drops the internal-token fallback entirely rather than replicating the host check. A ticket flow already exists and is already what browsers use; keeping a second, weaker path for header-capable clients buys nothing and is the whole vulnerability. Cost if wrong: a non-browser automation client that today connects with the raw token must call `POST /api/apps/pty-ws-ticket` first. That endpoint already exists and the change is one extra request.

- [ ] **Step 1: Write the failing test for the PTY path**

The upgrade handler in `scripts/bridge-http-server.ts` is not currently unit-testable — it is inline in `main()`. Extract the authorization decision into a pure, exported function in a new file `libs/ptyWsAuth.ts` so it can be tested, then have the server call it. Write the test first:

```ts
// libs/__tests__/ptyWsAuth.test.ts
import { authorizePtyUpgrade } from "../ptyWsAuth";

it("rejects a raw internal token with no ticket", () => {
  const r = authorizePtyUpgrade({
    cookieHeader: undefined,
    internalTokenHeader: "the-real-internal-token",
    ticket: undefined,
  });
  expect(r.ok).toBe(false);
});

it("accepts a valid one-time ticket", () => {
  const ticket = mintPtyWsTicket("operator@example.com");
  const r = authorizePtyUpgrade({
    cookieHeader: undefined,
    internalTokenHeader: undefined,
    ticket,
  });
  expect(r.ok).toBe(true);
});

it("accepts a valid session cookie", () => {
  const r = authorizePtyUpgrade({
    cookieHeader: validSessionCookie(),
    internalTokenHeader: undefined,
    ticket: undefined,
  });
  expect(r.ok).toBe(true);
});
```

Read `libs/ptyWsTickets.ts` for the real mint/consume function names and `libs/auth.ts` for how a session cookie is verified, and use those exact APIs.

- [ ] **Step 2: Run the test to verify it fails**

Run: `bunx vitest run libs/__tests__/ptyWsAuth.test.ts`
Expected: FAIL — `libs/ptyWsAuth.ts` does not exist.

- [ ] **Step 3: Create `libs/ptyWsAuth.ts`**

Move the decision out of `scripts/bridge-http-server.ts:239-267` into an exported function. Cookie path and ticket path both accepted; **the internal-token header is not consulted at all**:

```ts
/**
 * Authorize a PTY WebSocket upgrade.
 *
 * Deliberately does NOT honour `x-bridge-internal-token`. Every other
 * consumer of that bypass sits behind `proxy.ts`'s same-host gate; the
 * raw `server.on("upgrade")` listener bypasses Next middleware entirely,
 * so the token alone would hand any holder an interactive shell — and
 * the token lives in the env of every spawned child (audit C5).
 *
 * Header-less clients (browsers) already use the one-time ticket path;
 * automation should mint a ticket via POST /api/apps/pty-ws-ticket too.
 */
export function authorizePtyUpgrade(args: {
  cookieHeader: string | undefined;
  internalTokenHeader: string | undefined;
  ticket: string | undefined;
}): { ok: true; sub: string } | { ok: false; reason: string } { … }
```

- [ ] **Step 4: Wire the server to it**

In `scripts/bridge-http-server.ts`, replace lines 239-267 with a call to `authorizePtyUpgrade`. Keep the existing `rejectUpgrade(socket, 401, …)` call and its helpful diagnostic message, extending the message to say a ticket is now required for non-cookie clients.

- [ ] **Step 5: Fix the `proxy.ts` host check**

The Next middleware cannot see `req.socket`. Have the HTTP server stamp the connection's real remote address onto the request before handing it to Next, and have `proxy.ts` trust that instead of `Host`.

In `scripts/bridge-http-server.ts`, in the `createServer` callback, set a header the outside world cannot forge — strip any inbound copy first:

```ts
const server = createServer((req, res) => {
  // Stamp the REAL peer address for proxy.ts's same-host gate. Delete
  // any client-supplied value first: this header is server-authored and
  // must never be attacker-controlled (audit H2).
  delete req.headers[PEER_ADDR_HEADER];
  const peer = req.socket.remoteAddress;
  if (peer) req.headers[PEER_ADDR_HEADER] = peer;
  const parsed = parseUrl(req.url || "", true);
  void handle(req, res, parsed);
});
```

Define `PEER_ADDR_HEADER = "x-bridge-peer-addr"` in a small shared module both `proxy.ts` and the server import.

In `proxy.ts:179-191`, replace the `Host`-derived `isLoopbackHost` with a check on that header:

```ts
  // Same-host detection MUST come from the TCP peer, not the `Host`
  // header — a non-browser client can send `Host: localhost` and forge
  // the old check. libs/setupToken.ts documents this exact attack; that
  // lesson had not been applied here (audit H2).
  const peer = (req.headers.get(PEER_ADDR_HEADER) || "").replace(/^::ffff:/, "");
  const isLoopbackPeer = peer === "127.0.0.1" || peer === "::1";
  const viaProxy =
    !isLoopbackPeer ||
    !!req.headers.get("x-forwarded-for") ||
    !!req.headers.get("x-real-ip") ||
    !!req.headers.get("forwarded");
```

Keep the forwarding-header signals — they still correctly mark a genuine proxy chain.

- [ ] **Step 6: Manually verify the child-agent path still works**

This change can break every spawned child's callback if the header is not stamped. Start the bridge and confirm a child can still self-register:

Run: `bun run dev` in one shell; in another, with `$T` set to the `internalToken` value from `~/.claude/bridge.json`:
`curl -s -o /dev/null -w '%{http_code}\n' -H "x-bridge-internal-token: $T" http://127.0.0.1:7777/api/tasks`
Expected: `200`. If it returns 307/401, the header is not reaching `proxy.ts` — fix that before committing. Record the observed status in your report file.

- [ ] **Step 7: Run the tests**

Run: `bun run typecheck && bun run lint && bun run test`

- [ ] **Step 8: Commit**

```bash
git add libs/ptyWsAuth.ts libs/__tests__/ptyWsAuth.test.ts scripts/bridge-http-server.ts proxy.ts
git add -u libs
git commit -m "fix(auth): derive same-host from the TCP peer, require a ticket for PTY WS

proxy.ts trusted the client-supplied Host header for its internal-token
gate — the exact attack libs/setupToken.ts documents. The PTY upgrade
bypassed that gate entirely and accepted the raw token, which every
spawned child carries in its env."
```

---

### Task 6: Bind a guest's spawns to their own task's app

**Finding (C4, Critical):** `authorizeGuestRequest`'s rule for `POST /api/tasks/:tid/agents` (`libs/guestAccess.ts:89`) checks only that the URL's `:tid` matches the share's `taskId` and that the `spawnAgent` grant is set — it never inspects the request body. In the route, `repo = explicitRepo` comes straight from `body.repo` (`app/api/tasks/[id]/agents/route.ts:360`) and is passed to `resolveRepoCwd` (`libs/repos.ts:47-58`), which resolves **any** app registered in `bridge.json` plus the bridge's own root folder. Nothing compares `repo` against `meta.taskApp`. A guest shared into a task pinned to app A can spawn a full agent in unrelated app B and read its whole transcript via `/tail`, because `sessionBelongsToTask` only checks task membership, not repo.

**Files:**
- Modify: `app/api/tasks/[id]/agents/route.ts` (after `repo` is resolved, before `resolveRepoCwd` is used for any side effect)
- Test: new `libs/__tests__/guestRepoBinding.test.ts`

**Interfaces:**
- Consumes: `actor` (the request's authenticated principal, `{ kind: "guest" | "operator", … }`) as already used at `app/api/tasks/[id]/agents/route.ts:398,413`; `meta.taskApp` as already used at `:348,427`.
- Produces: no new exports.

**Ruling carried into this task:** enforce in the route, not in `guestAccess.ts`. The allowlist there is a pure URL/method/grant matcher with no body access and no meta reads; giving it those would change its shape and its test surface. The route already has both `actor` and `meta` in hand. Cost if wrong: the check lives one layer further in than ideal, so a future second spawn route would need its own copy — mitigated by the test below asserting the behaviour, not the location.

- [ ] **Step 1: Write the failing test**

Extract the decision into a pure exported helper so it is testable without standing up a Next route. Add to `app/api/tasks/[id]/agents/route.ts` (exported) or a small `libs/guestRepoBinding.ts` — prefer the lib so the test does not import a route module:

```ts
// libs/__tests__/guestRepoBinding.test.ts
import { guestMayTargetRepo } from "../guestRepoBinding";

it("lets a guest spawn into the app their task is pinned to", () => {
  expect(guestMayTargetRepo({ actorKind: "guest", repo: "app-a", taskApp: "app-a" })).toBe(true);
});

it("blocks a guest spawning into a different registered app", () => {
  expect(guestMayTargetRepo({ actorKind: "guest", repo: "app-b", taskApp: "app-a" })).toBe(false);
});

it("blocks a guest when the task is not pinned to any app", () => {
  expect(guestMayTargetRepo({ actorKind: "guest", repo: "app-a", taskApp: null })).toBe(false);
});

it("does not restrict the operator", () => {
  expect(guestMayTargetRepo({ actorKind: "operator", repo: "app-b", taskApp: "app-a" })).toBe(true);
});
```

The third case matters: an unpinned task gives a guest no bound at all, so deny rather than allow.

- [ ] **Step 2: Run the test to verify it fails**

Run: `bunx vitest run libs/__tests__/guestRepoBinding.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the helper**

```ts
// libs/guestRepoBinding.ts
/**
 * A task-share guest may only ever drive agents in the app their task is
 * pinned to. The guest allowlist (libs/guestAccess.ts) matches on URL,
 * method and grant only — it never sees the request body, so `body.repo`
 * reached resolveRepoCwd unchecked and resolved ANY registered app
 * (audit C4). An unpinned task gives no bound, so it denies.
 */
export function guestMayTargetRepo(args: {
  actorKind: "guest" | "operator";
  repo: string;
  taskApp: string | null;
}): boolean {
  if (args.actorKind !== "guest") return true;
  if (!args.taskApp) return false;
  return args.repo === args.taskApp;
}
```

- [ ] **Step 4: Enforce it in both the spawn and resume paths**

In `app/api/tasks/[id]/agents/route.ts`, immediately after `repo` is finalised (after the auto-detect block ending at line 380, before `resolveRepoCwd` at line 382):

```ts
  if (!guestMayTargetRepo({
    actorKind: actor?.kind === "guest" ? "guest" : "operator",
    repo,
    taskApp: meta.taskApp ?? null,
  })) {
    return NextResponse.json(
      { error: "guest may only target this task's app" },
      { status: 403 },
    );
  }
```

Then check `handleResume` (from line 1249) — if it can also act on a caller-supplied repo, apply the same guard there. If it derives the repo solely from the prior run's record, note that in your report file and add no second guard.

- [ ] **Step 5: Run the tests**

Run: `bunx vitest run libs/__tests__/guestRepoBinding.test.ts && bun run typecheck && bun run test`

- [ ] **Step 6: Commit**

```bash
git add libs/guestRepoBinding.ts libs/__tests__/guestRepoBinding.test.ts "app/api/tasks/[id]/agents/route.ts"
git commit -m "fix(guest): bind a share's spawns to that task's own app

The guest allowlist never inspected body.repo, so a spawnAgent grant on
one task let a guest launch agents in any registered app and read the
transcript back through the task-scoped tail route."
```

---

## Phase D — Propagate the patterns the repo already got right

Each task here copies an implementation that already exists elsewhere in this repo. The reference is named in every case; do not invent an alternative.

### Task 7: Abort the merge when worktree merge-back conflicts

**Finding (C6, Critical):** `mergeAndRemoveWorktreeLocked` (`libs/worktrees.ts:368-396`) checks out the base branch in the **live** app tree and runs `git merge --no-ff --no-edit <spawnBranch>`. On failure it returns `{ ok: false }` and nothing else — no `git merge --abort`, and no caller cleans up (`performWorktreeMergeBack` in `libs/runLifecycle.ts:962-975`, and the confidence `ship` route). Its sibling `mergeIntoTargetBranchLocked` (`libs/gitOps.ts:648-658`) does it correctly. Consequence: a conflicting merge-back leaves the operator's **primary checkout** mid-merge with `MERGE_HEAD` and conflict markers, so every future task against that app fails its dirty-check until a human intervenes.

**Files:**
- Modify: `libs/worktrees.ts:381-396`
- Test: `libs/__tests__/worktrees.test.ts`

**Reference implementation — `libs/gitOps.ts:648-658`, copy this behaviour:**

```ts
  if (!merge.ok) {
    // Conflict (or any other merge failure): abort cleanly, return to
    // source so the operator finds their work where they left it.
    await runGit(cwd, ["merge", "--abort"]);
    await runGit(cwd, ["checkout", source]);
    return {
      ok: false,
      message: `git merge ${source} → ${target} failed (aborted, back on ${source})`,
      error: merge.stderr || `exit ${merge.code}`,
    };
  }
```

- [ ] **Step 1: Write the failing test**

`libs/__tests__/worktrees.test.ts` already drives real git (see its `createWorktreeForRun + removeWorktree (real git)` block). Add a conflict case in the same style:

```ts
it("aborts the merge and leaves the live tree clean when merge-back conflicts", async () => {
  // Set up: base branch with a file; worktree branch edits line 1;
  // live tree commits a conflicting edit to line 1 on the base branch.
  // ... build both edits so the merge is guaranteed to conflict ...

  const res = await mergeAndRemoveWorktree({ appPath, handle });

  expect(res.ok).toBe(false);
  // The live tree must NOT be left mid-merge.
  const status = await runGit(appPath, ["status", "--porcelain"]);
  expect(status.stdout.trim()).toBe("");
  const mergeHead = existsSync(join(appPath, ".git", "MERGE_HEAD"));
  expect(mergeHead).toBe(false);
});
```

Use the file's existing temp-repo helpers rather than writing new ones.

- [ ] **Step 2: Run the test to verify it fails**

Run: `bunx vitest run libs/__tests__/worktrees.test.ts`
Expected: FAIL — `MERGE_HEAD` exists and `git status --porcelain` is non-empty.

- [ ] **Step 3: Implement**

In `libs/worktrees.ts`, replace the `if (!merge.ok)` block at 390-396:

```ts
  if (!merge.ok) {
    // Conflict (or any other failure): abort so the LIVE tree isn't left
    // mid-merge with MERGE_HEAD set — that wedges every later task
    // against this app at its dirty-check (audit C6). Mirrors
    // mergeIntoTargetBranchLocked in gitOps.ts. The worktree is left in
    // place, so no work is lost.
    await runGit(appPath, ["merge", "--abort"]);
    return {
      ok: false,
      message: `merge of ${handle.branch} into ${handle.baseBranch} failed (aborted; worktree kept at ${handle.path})`,
      error: merge.stderr,
    };
  }
```

Do **not** add a `git checkout` back to another branch here — unlike `gitOps`, this function deliberately left the live tree on `baseBranch`, and the worktree still holds the work.

- [ ] **Step 4: Run the test to verify it passes**

Run: `bunx vitest run libs/__tests__/worktrees.test.ts`
Expected: PASS, all other worktree tests still green.

- [ ] **Step 5: Commit**

```bash
git add libs/worktrees.ts libs/__tests__/worktrees.test.ts
git commit -m "fix(worktrees): abort the merge when merge-back conflicts

A failed merge-back left the operator's primary checkout mid-merge with
MERGE_HEAD set, wedging every later task against that app. gitOps.ts's
sibling already handled this correctly."
```

---

### Task 8: Stop terminal runs being resurrected, and stop clearing a hold on a failed push

Two independent precondition bugs, batched because both are one-guard fixes in route handlers and share a review surface.

**Finding (H4, High):** `app/api/tasks/[id]/link/route.ts:98-107` calls `updateRun` with no precondition, unlike `failRun`/`succeedRun` which guard `(run) => run.status === "running"` specifically so a late write cannot demote a row that already reached a terminal state. The child prompt instructs children to self-register once and not re-POST, but nothing enforces that server-side. A late self-register overwrites `done`/`failed` back to `running` with no live process — a zombie the coordinator waits on and the reaper won't touch for its full cutoff (default 4h).

**Finding (H6, High):** `app/api/tasks/[id]/runs/[sessionId]/confidence/review/route.ts:134-193` — the live-tree `ship` branch calls `autoCommitAndPush`. If that *resolves* `{ok:false}` (a rejected push) rather than throwing, execution falls through to an unconditional `updateRun({confidence:{heldAt:null}})` at :190-193. The worktree branch at :108-126 does this correctly: it early-returns and keeps the hold, stamping `markMergeNotPushed`. So the gate renders green while the code that triggered the hold was never pushed.

**Files:**
- Modify: `app/api/tasks/[id]/link/route.ts:98-107`, `app/api/tasks/[id]/runs/[sessionId]/confidence/review/route.ts:134-193`
- Test: new `libs/__tests__/runStatusTransitions.test.ts`

**Interfaces:**
- Consumes: `updateRun(dir, sessionId, patch, precondition?)` from `libs/meta.ts` — the 4th parameter is the precondition predicate, already used throughout `runLifecycle.ts`.
- Produces: an exported `isBackwardStatusTransition(from, to)` helper in `libs/runStatus.ts` (keep that file dependency-free).

- [ ] **Step 1: Write the failing test**

```ts
// libs/__tests__/runStatusTransitions.test.ts
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bunx vitest run libs/__tests__/runStatusTransitions.test.ts`
Expected: FAIL — `isBackwardStatusTransition` is not exported.

- [ ] **Step 3: Implement the helper and guard the link route**

In `libs/runStatus.ts`:

```ts
const TERMINAL: readonly RunStatus[] = ["done", "failed", "cancelled", "stale"];

/**
 * A late writer must never move a row that already reached a terminal
 * state back to an active one. The link route accepted exactly that
 * from a child's self-register curl, producing a zombie row no process
 * backed and the reaper wouldn't touch for hours (audit H4).
 */
export function isBackwardStatusTransition(from: RunStatus, to: RunStatus): boolean {
  return TERMINAL.includes(from) && (to === "running" || to === "queued");
}
```

In `app/api/tasks/[id]/link/route.ts`, pass a precondition to the existing `updateRun`:

```ts
  if (existing) {
    await updateRun(
      dir,
      body.sessionId,
      {
        role: body.role, repo: body.repo,
        ...(body.status ? { status: body.status } : {}),
      },
      (r) => !body.status || !isBackwardStatusTransition(r.status, body.status),
    );
  }
```

- [ ] **Step 4: Guard the confidence ship path**

In `app/api/tasks/[id]/runs/[sessionId]/confidence/review/route.ts`, make the live-tree branch behave like the worktree branch at :108-126 — on `pushResult.ok === false`, stamp the not-pushed marker and **early-return keeping the hold**, so the unconditional clear at :190-193 is never reached. Read the worktree branch and mirror its exact response shape and marker call so the UI renders both paths identically.

- [ ] **Step 5: Run the tests**

Run: `bunx vitest run libs/__tests__/runStatusTransitions.test.ts && bun run typecheck && bun run test`

- [ ] **Step 6: Commit**

```bash
git add libs/runStatus.ts libs/__tests__/runStatusTransitions.test.ts "app/api/tasks/[id]/link/route.ts" "app/api/tasks/[id]/runs/[sessionId]/confidence/review/route.ts"
git commit -m "fix(runs): reject backward status writes; keep the hold when ship's push fails

The link route let a late self-register resurrect a terminal run into a
zombie; the confidence ship path cleared heldAt even when the push had
failed, rendering the gate green on unpushed code."
```

---

### Task 9: Telegram — bound the long-poll and stop truncating mid-tag

Both fixes are in `libs/telegramCommands.ts` and both restore a pattern `libs/telegramNotifier.ts` already implements. Batched as one task.

**Finding (H8, High):** `fetchUpdates` (`libs/telegramCommands.ts:180-201`) calls `fetch(url, { method: "GET", signal: poller.abort?.signal })` at :189-192. `poller.abort` only fires on explicit shutdown, never per request. Every other outbound Telegram call in the codebase pins `AbortSignal.timeout(10_000)`. If the connection stalls without a clean FIN/RST — routine on a laptop that sleeps or drops Wi-Fi — the `await fetch` never settles, `runLoop`'s `catch` and its `POLL_RESTART_DELAY_MS` backoff never run, and every `/kill`, `/allow`, `/tasks` over Telegram goes unanswered until a manual restart.

**Finding (H9, High):** `sendReply` (`libs/telegramCommands.ts:1135`) does `text.length > REPLY_MAX ? text.slice(0, REPLY_MAX) + "…" : text` on a string that has **already been converted to HTML** by `mdLiteToHtml`, so the cut lands inside a tag with high probability. Telegram's `parse_mode: "HTML"` then rejects the whole `sendMessage` with 400 "can't parse entities" — and `sendReply` (:1146-1161) is a single attempt whose failure is only `console.warn`'d, unlike `sendViaBot` (`libs/telegramNotifier.ts:206-277`) which retries 429/5xx with backoff and re-sends without `parse_mode` on a parse error. List commands (`/tasks`, `/apps`, `/runs`, `/pending`, `/logins`) render one unbounded line per item at ~100-120 chars, so ~25-30 open tasks is enough to trip it and the operator gets no reply at all.

**Files:**
- Modify: `libs/telegramCommands.ts` (`fetchUpdates` ~:180-201, `sendReply` ~:1130-1161, and the list renderers e.g. `renderTasks` ~:513-529)
- Test: `libs/__tests__/telegramCommands.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
it("truncates before HTML conversion so tags stay balanced", () => {
  const long = Array.from({ length: 200 }, (_, i) => `- \`t_2026_${i}\` **title ${i}**`).join("\n");
  const out = buildReplyBody(long); // the function that decides final text
  // Every opening tag has a matching close.
  const opens = (out.match(/<(b|code|i)>/g) ?? []).length;
  const closes = (out.match(/<\/(b|code|i)>/g) ?? []).length;
  expect(opens).toBe(closes);
});

it("caps list output with a +N more suffix rather than a hard cut", () => {
  const rows = Array.from({ length: 120 }, (_, i) => makeTask(i));
  const out = renderTasks(rows);
  expect(out).toMatch(/\+\d+ more/);
});
```

For the timeout, assert the signal is composed rather than mocking the network:

```ts
it("bounds each getUpdates request with its own timeout", async () => {
  const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(okUpdatesResponse());
  await fetchUpdates(/* … */);
  const init = fetchSpy.mock.calls[0][1] as RequestInit;
  expect(init.signal).toBeDefined();
  expect(init.signal!.aborted).toBe(false);
  // A signal that only ever aborts on shutdown is the bug; assert the
  // request-level timeout is part of the composition.
  expect(composedFromTimeout(init.signal!)).toBe(true);
});
```

If `composedFromTimeout` is not expressible in this harness, instead extract a small exported `buildPollSignal(abortSignal)` and unit-test that it returns a signal which aborts after the expected delay using fake timers. Prefer the extraction — it is testable and self-documenting.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bunx vitest run libs/__tests__/telegramCommands.test.ts`
Expected: FAIL on all three.

- [ ] **Step 3: Bound the poll**

```ts
  const r = await fetch(url, {
    method: "GET",
    // Long-poll needs its own request-level deadline. `poller.abort`
    // only fires on shutdown, so a connection that stalls without a
    // clean FIN left this await pending forever — runLoop's catch and
    // its restart backoff never ran and the bot went silent (audit H8).
    signal: buildPollSignal(poller.abort?.signal),
  });
```

```ts
export function buildPollSignal(shutdown: AbortSignal | undefined): AbortSignal {
  const deadline = AbortSignal.timeout(POLL_TIMEOUT_S * 1000 + 10_000);
  return shutdown ? AbortSignal.any([shutdown, deadline]) : deadline;
}
```

- [ ] **Step 4: Fix truncation and add the send fallback**

Truncate the **pre-HTML** string, then convert — so `mdLiteToHtml` always emits balanced tags. Cap the list renderers at a constant N with a `+K more` suffix rather than relying on truncation at all. Then give `sendReply` the same resilience `sendViaBot` has: on a 400 parse error, retry once without `parse_mode`; on 429/5xx, honour `retry_after` with backoff. Read `libs/telegramNotifier.ts:206-277` and reuse its logic — extract a shared helper if the duplication is more than a few lines, since Task 12's whole purpose is removing this class of divergence.

- [ ] **Step 5: Run the tests**

Run: `bunx vitest run libs/__tests__/telegramCommands.test.ts && bun run typecheck && bun run test`

- [ ] **Step 6: Commit**

```bash
git add libs/telegramCommands.ts libs/__tests__/telegramCommands.test.ts
git commit -m "fix(telegram): bound the long-poll and truncate before HTML conversion

An unbounded getUpdates fetch wedged the poller silently on a stalled
connection; slicing already-converted HTML cut mid-tag and Telegram
rejected the whole reply with no fallback, so commands got no answer."
```

---

### Task 10: Rate-limit the exec route

**Finding (M4, Medium):** `app/api/apps/[name]/exec/route.ts` never calls `checkRateLimit`, while its same-directory siblings do — `commit/route.ts:35` uses `checkRateLimit("apps:commit:ip", ip, 10, 60_000)` and `scan/route.ts:41` uses `checkRateLimit("apps:scan:ip", ip, 3, 5*60_000)`, both because they shell out. `exec` spawns an arbitrary shell command (`cmd.exe /c` / `sh -c`) with a 30s budget per call — strictly more expensive and more dangerous than either — and is the one route in the trio left unguarded.

**Files:**
- Modify: `app/api/apps/[name]/exec/route.ts`
- Test: `libs/__tests__/rateLimit.test.ts` (extend if it exists; the route itself is not unit-testable, so assert the limiter's behaviour for the new bucket key)

- [ ] **Step 1: Add the guard, mirroring the siblings exactly**

Read `app/api/apps/[name]/commit/route.ts:35` for the exact import and call shape, then add to `exec/route.ts` at the same position in the handler (after auth, before any process spawn):

```ts
  const ip = getClientIp(req.headers);
  const rl = checkRateLimit("apps:exec:ip", ip, 6, 60_000);
  if (!rl.ok) return tooManyRequests(rl);
```

Use whatever rejection helper the sibling routes use — copy it, do not invent one. Budget: 6 per minute, deliberately tighter than `commit`'s 10 because each call can occupy a process slot for 30s.

- [ ] **Step 2: Verify**

Run: `bun run typecheck && bun run lint && bun run test`

- [ ] **Step 3: Commit**

```bash
git add "app/api/apps/[name]/exec/route.ts"
git commit -m "fix(exec): rate-limit the arbitrary-command route

commit and scan in the same directory are both throttled because they
shell out; exec spawns an arbitrary shell command with a 30s budget and
had no limit at all."
```

---

## Phase E — Extract the shared helpers so these classes cannot return

### Task 11: Extract an SSE helper and fix the two leaking routes

**Finding (H3, High):** `app/api/tasks/[id]/events/route.ts:43-198` and `app/api/sessions/[sessionId]/permission/stream/route.ts:28-70` build a `ReadableStream` with only a `start(controller)` handler; teardown is wired solely to `req.signal`'s abort event. Two sibling SSE routes were hardened with a `cancel()` hook — `app/api/sessions/[sessionId]/tail/stream/route.ts:335-339`, whose comment reads *"the runtime can cancel a ReadableStream independently of req.signal (e.g. on a server reload)… without this the keepalive interval / session listener / fs.watch would leak"*, and `app/api/apps/auto-detect/stream/route.ts:78-82`. The fix was never back-ported. A dev-server HMR reload or a tunnel dropping the connection cancels the stream without an abort event, so the 15s keepalive `setInterval` ticks forever and the listener stays registered — and `libs/permissionStore.ts:139-153` only evicts a per-session emitter when `listenerCount === 0`, so a leaked listener pins it permanently.

**Files:**
- Create: `libs/sse.ts`
- Modify: `app/api/tasks/[id]/events/route.ts`, `app/api/sessions/[sessionId]/permission/stream/route.ts`, and — once the helper is proven — `app/api/sessions/[sessionId]/tail/stream/route.ts`, `app/api/apps/auto-detect/stream/route.ts`
- Test: new `libs/__tests__/sse.test.ts`

**Interfaces:**
- Produces: `createSseResponse({ onStart, keepaliveMs })` returning a `Response`, where `onStart(send)` returns a teardown function invoked on **both** `req.signal` abort and stream `cancel()`, exactly once.

- [ ] **Step 1: Write the failing test**

```ts
// libs/__tests__/sse.test.ts
it("runs teardown exactly once when the stream is cancelled", async () => {
  const teardown = vi.fn();
  const res = createSseResponse({ onStart: () => teardown, keepaliveMs: 50 });
  await res.body!.cancel();
  expect(teardown).toHaveBeenCalledTimes(1);
});

it("runs teardown exactly once when the request aborts", async () => {
  const ac = new AbortController();
  const teardown = vi.fn();
  createSseResponse({ signal: ac.signal, onStart: () => teardown, keepaliveMs: 50 });
  ac.abort();
  await Promise.resolve();
  expect(teardown).toHaveBeenCalledTimes(1);
});

it("does not run teardown twice when both fire", async () => {
  const ac = new AbortController();
  const teardown = vi.fn();
  const res = createSseResponse({ signal: ac.signal, onStart: () => teardown, keepaliveMs: 50 });
  ac.abort();
  await res.body!.cancel();
  expect(teardown).toHaveBeenCalledTimes(1);
});
```

The third test is the load-bearing one — double teardown is how "fix the leak" turns into "double-unsubscribe crashes".

- [ ] **Step 2: Run the test to verify it fails**

Run: `bunx vitest run libs/__tests__/sse.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `libs/sse.ts`**

Read `app/api/sessions/[sessionId]/tail/stream/route.ts:168-340` first — it is the reference implementation, including its hoisted `closeRef` and its `cancel() { closeRef?.(); }`. Generalise exactly that, adding an idempotence guard so teardown runs once.

- [ ] **Step 4: Convert the two leaking routes**

Rewrite `app/api/tasks/[id]/events/route.ts` and `app/api/sessions/[sessionId]/permission/stream/route.ts` to use `createSseResponse`. Their `onStart` returns a teardown that clears the keepalive and calls the existing `unsub()`. Behaviour — event names, payload shapes, keepalive interval — must be byte-identical; this is a refactor, not a redesign.

- [ ] **Step 5: Convert the two already-correct routes**

Only after the first two are green, migrate `tail/stream` and `auto-detect/stream` onto the same helper so a future fix has one home. If either has behaviour the helper cannot express, **leave it alone** and note why in your report file — do not bend the helper to fit.

- [ ] **Step 6: Verify manually**

Run: `bun run dev`, log in, open a task, confirm the log streams and permission prompts still arrive. Record what you observed in your report file. This is the SSE path the Next 16.3 upgrade also left unverified, so this observation is doubly valuable.

- [ ] **Step 7: Verify and commit**

Run: `bun run typecheck && bun run lint && bun run test`

```bash
git add libs/sse.ts libs/__tests__/sse.test.ts app/api
git commit -m "refactor(sse): one helper with idempotent teardown; fix two leaking routes

tasks/events and permission/stream only tore down on req.signal abort,
so an HMR reload or dropped tunnel leaked their keepalive interval and
a permissionStore listener permanently. Two sibling routes already had
the cancel() fix; it was never back-ported."
```

---

### Task 12: Restrict the four auxiliary `claude -p` spawns

**Finding (H1, High):** `libs/telegramIntent.ts:169-177`, `libs/detect/llm.ts:141-155`, `libs/scanApp.ts:54-68` and `libs/commitMessage.ts:285-296` each hand-roll a `node:child_process.spawn` of `claude -p --permission-mode bypassPermissions` with **no** `--disallowed-tools`. Verified counts: those four files contain 0 occurrences of `disallowed-tools`/`disallowedTools`; `libs/coordinator.ts` is the only file that uses it (2 occurrences), because `CLAUDE.md` requires blocking the `Task` tool. The four unrestricted sites take *less* trusted input than the coordinator: free-form Telegram text (reachable via NL routing and `/new`, `/refresh`, `/scan`), and — for `commitMessage` — the diff of a dirty tree, with `cwd` set to that very tree, so a child with unrestricted Bash can `git checkout -- .` the uncommitted work the dialog exists to save. `commitMessage.ts:184-186`'s own comment notes Bash is now optional since the diff is pre-embedded, so the wide grant has no remaining functional justification.

**Files:**
- Modify: `libs/telegramIntent.ts`, `libs/detect/llm.ts`, `libs/scanApp.ts`, `libs/commitMessage.ts`
- Test: new `libs/__tests__/auxSpawnRestrictions.test.ts`

**Interfaces:**
- Consumes: `libs/spawn.ts`'s existing options, which already support a disallowed-tools list (see how `libs/coordinator.ts:209` passes it).
- Produces: a shared `readOnlyChildArgs()` (or equivalent) so all four sites share one definition.

**Ruling carried into this task:** these four tasks — command routing, repo-scope detection, a one-sentence app summary, and a commit message — need no tools at all. Restrict rather than remove `bypassPermissions`, because a non-interactive `-p` run would otherwise hang on an approval prompt it cannot answer. Deny at minimum: `Bash`, `Write`, `Edit`, `MultiEdit`, `NotebookEdit`, `WebFetch`, `Task`.

- [ ] **Step 1: Write the failing test**

```ts
it("every auxiliary claude spawn denies write and shell tools", () => {
  const args = readOnlyChildArgs();
  const flag = args[args.indexOf("--disallowed-tools") + 1];
  for (const tool of ["Bash", "Write", "Edit", "MultiEdit", "NotebookEdit", "WebFetch", "Task"]) {
    expect(flag).toContain(tool);
  }
});
```

Plus one guard test per call site asserting the built argv contains `--disallowed-tools`. Extract each site's argv construction into a small exported function if needed to make that assertion possible.

- [ ] **Step 2: Run the test to verify it fails**

Run: `bunx vitest run libs/__tests__/auxSpawnRestrictions.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

Add the shared definition next to the existing spawn helpers, with a comment naming why:

```ts
/** Auxiliary `claude -p` calls (command routing, scope detection, app
 *  summary, commit message) analyse text that is already embedded in
 *  their prompt — none needs tools. They ran with bypassPermissions and
 *  no restrictions, several on untrusted input, and commitMessage ran
 *  inside the dirty tree it was summarising (audit H1). */
export function readOnlyChildArgs(): string[] {
  return ["--disallowed-tools", "Bash,Write,Edit,MultiEdit,NotebookEdit,WebFetch,Task"];
}
```

Apply it at all four sites. Verify the exact flag spelling the installed `claude` CLI expects by checking how `libs/coordinator.ts:209` passes it, and match that.

- [ ] **Step 4: Smoke-test one real path**

The commit-message suggester is the easiest to exercise. Make a trivial edit in a scratch repo registered as an app, call the suggest endpoint, and confirm a message still comes back. Record the result in your report file — if restricting tools breaks the feature, that is a finding, not something to work around by loosening the list.

- [ ] **Step 5: Verify and commit**

Run: `bun run typecheck && bun run lint && bun run test`

```bash
git add libs/telegramIntent.ts libs/detect/llm.ts libs/scanApp.ts libs/commitMessage.ts libs/__tests__/auxSpawnRestrictions.test.ts
git add -u libs
git commit -m "fix(spawn): deny write/shell tools to the four auxiliary claude children

coordinator.ts was the only site passing --disallowed-tools. The four
that skipped it take less trusted input, and commitMessage ran with
unrestricted Bash inside the dirty tree it was summarising."
```

---

### Task 13: Extract the triplicated run-working-tree resolution

**Finding (M3, Medium):** An identical `isUnderAppRoot(appPath, candidate)` appears at `app/api/tasks/[id]/runs/[sessionId]/diff/route.ts:33-38`, `…/commit/route.ts:44-49` and `…/commit/suggest/route.ts:31-36`, each paired with an identical ~18-line "resolve worktree, else app.path, else BRIDGE.md fallback" block (`diff:118-137`, `commit:91-108`, `suggest:53-70`). Per `diff/route.ts:113-117`'s own comment, `isUnderAppRoot` is the defence-in-depth gate against a hand-edited `meta.json.worktreePath` escaping the app root. Three unsynchronised copies means a future hardening fix (symlink escape, Windows case-folding) applied to one or two silently leaves the others exposed.

**Files:**
- Create: `libs/runWorkingTree.ts`
- Modify: the three routes above
- Test: new `libs/__tests__/runWorkingTree.test.ts`

**Interfaces:**
- Produces: `isUnderAppRoot(appPath: string, candidate: string): boolean` and `resolveRunCwd(run: Run, app: App): string`.

- [ ] **Step 1: Write the failing test**

Cover the containment gate properly — this is security-relevant code getting its first real test:

```ts
it("accepts a path inside the app root", () => {
  expect(isUnderAppRoot("/repo/app", "/repo/app/.worktrees/x")).toBe(true);
});
it("rejects a sibling directory", () => {
  expect(isUnderAppRoot("/repo/app", "/repo/app-evil")).toBe(false);
});
it("rejects traversal", () => {
  expect(isUnderAppRoot("/repo/app", "/repo/app/../other")).toBe(false);
});
it("rejects an unrelated absolute path", () => {
  expect(isUnderAppRoot("/repo/app", "/etc")).toBe(false);
});
```

The sibling-prefix case (`/repo/app` vs `/repo/app-evil`) is the classic bug in naive `startsWith` implementations — assert it explicitly. On Windows also assert a case-difference case if the current implementation claims to handle it; if it does not, do **not** add the behaviour in this task — note it in your report file as a follow-up, since changing the security semantics is out of scope for an extraction.

- [ ] **Step 2: Run the test to verify it fails**

Run: `bunx vitest run libs/__tests__/runWorkingTree.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Extract, preserving behaviour exactly**

Copy the implementation from `diff/route.ts` verbatim into `libs/runWorkingTree.ts`. **Do not "improve" it during the move** — if the tests above reveal a weakness, record it in your report file and leave the behaviour identical. An extraction that also changes semantics is unreviewable.

- [ ] **Step 4: Convert the three routes**

Replace each local copy with an import. Diff the three original blocks against each other first: if any has drifted from the others, use `diff/route.ts`'s version (the one whose comment documents the intent) and note the drift in your report file.

- [ ] **Step 5: Verify and commit**

Run: `bun run typecheck && bun run lint && bun run test`

```bash
git add libs/runWorkingTree.ts libs/__tests__/runWorkingTree.test.ts app/api
git commit -m "refactor: extract the triplicated run-working-tree resolution

isUnderAppRoot is the containment gate against a hand-edited
worktreePath escaping the app root, and it existed in three
unsynchronised copies with no test."
```

---

## Phase F — Concurrency. Do not enable auto-queue before this phase lands.

### Task 14: Guard the resume path against double-spawn

**Finding (C7, Critical):** `handleResume` (`app/api/tasks/[id]/agents/route.ts:1249-1469`) does its liveness check (:1307-1318, :1339-1353) against the single `meta.runs` snapshot read once near the top of the POST handler (:329), then flips status at :1417-1424 with **no** `precondition` argument — unlike every other status-mutating call in `runLifecycle.ts`/`retrySpawn.ts`. The route never calls `withInFlight`. The spawn path protects against this exact race via `appendRunIfNotDuplicate`, which re-validates inside the per-task lock (`libs/meta.ts:817-839`); the resume path never got the equivalent. A coordinator retrying its POST after a network hiccup makes both requests pass the check and both call `resumeClaude`, so two `claude -p --resume` processes append turns to the same `.jsonl` concurrently — the exact corruption `libs/messageQueue.ts`'s header comment exists to prevent. Worse, `registerChild` (`libs/spawnRegistry.ts:31-41`) replaces the first registration, orphaning a process that Stop and the stale-run reaper can no longer target.

**Files:**
- Modify: `app/api/tasks/[id]/agents/route.ts` (`handleResume`)
- Test: new `libs/__tests__/resumeGuard.test.ts`

**Interfaces:**
- Consumes: `updateRun(dir, sessionId, patch, precondition)` — the precondition runs **inside** the per-task lock, which is what makes it atomic; `withInFlight(kind, key, fn)` from `libs/inFlight.ts`.

**Ruling carried into this task:** use the `updateRun` precondition as the primary guard (it is already atomic and matches `spawnRetry`'s established pattern) and treat a precondition miss as a 409, not a silent no-op — the caller must learn its retry lost the race. Cost if wrong: a legitimate resume racing an unrelated status write returns 409 and the operator retries.

- [ ] **Step 1: Write the failing test**

Extract the guard into a testable helper rather than trying to drive the whole route:

```ts
it("only the first of two concurrent resumes wins", async () => {
  const dir = await makeTaskDir({ runs: [{ sessionId: "s1", status: "done", role: "coder" }] });
  const results = await Promise.all([
    claimRunForResume(dir, "s1"),
    claimRunForResume(dir, "s1"),
  ]);
  expect(results.filter((r) => r.ok)).toHaveLength(1);
});

it("refuses to resume a run that is already running", async () => {
  const dir = await makeTaskDir({ runs: [{ sessionId: "s1", status: "running", role: "coder" }] });
  expect((await claimRunForResume(dir, "s1")).ok).toBe(false);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bunx vitest run libs/__tests__/resumeGuard.test.ts`
Expected: FAIL — helper does not exist; and if written naively without the precondition, the first test fails with 2 winners.

- [ ] **Step 3: Implement `claimRunForResume`**

```ts
/**
 * Atomically claim a terminal run for resume. The precondition runs
 * inside meta.ts's per-task lock, so two concurrent claims cannot both
 * succeed. handleResume previously checked liveness against a snapshot
 * read at the top of the request and flipped status with no
 * precondition, so a retried POST spawned a second `claude --resume`
 * against the same session id (audit C7).
 */
export async function claimRunForResume(dir: string, sessionId: string) { … }
```

It must set `{ status: "running", startedAt, endedAt: null }` under the precondition `(r) => r.status !== "running" && r.status !== "queued"`, and report whether the write applied.

- [ ] **Step 4: Wire `handleResume` to it**

Replace the unguarded `updateRun` at :1417-1424 with `claimRunForResume`. On a failed claim, return 409 with a message naming the current status. Only call `resumeClaude` after a successful claim.

- [ ] **Step 5: Verify and commit**

Run: `bunx vitest run libs/__tests__/resumeGuard.test.ts && bun run typecheck && bun run test`

```bash
git add "app/api/tasks/[id]/agents/route.ts" libs/__tests__/resumeGuard.test.ts
git add -u libs
git commit -m "fix(resume): claim the run atomically so a retried POST cannot double-spawn

handleResume checked liveness against a stale snapshot and flipped
status with no precondition, so two concurrent resumes both spawned
claude --resume against one session — and the registry kept only the
second, orphaning the first beyond Stop and the reaper."
```

---

### Task 15: Close the auto-queue dispatch race

**Finding (C8, Critical, currently latent):** `POST /api/tasks` writes `meta.json` with `taskSection: "TODO"` and `runs: []` (`app/api/tasks/route.ts:93`), then performs several awaits — heuristic detect, `writeScopeCache`, an **LLM** detect call, optionally `setIntake` — before finally calling `spawnCoordinatorForTask` at :171, whose `appendRun` is what takes `runs.length` from 0 to 1. `pickNextTodoTask` (`libs/autoQueue.ts:104-115`) treats `section === "TODO"` plus `runs.length === 0` as the whole eligibility test, and `autoQueueTick` (:146-150) spawns without re-verifying or taking a lock. A 30s scheduler tick landing in that multi-second window spawns a second coordinator for the same task; both can dispatch children into the same working tree. Verified as latent on this machine: `.bridge-state/auto-queue.json` is `{"enabled": false}`.

**Files:**
- Modify: `libs/autoQueue.ts`
- Test: `libs/__tests__/autoQueue.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
it("skips a task whose meta.json was written moments ago", () => {
  const justCreated = makeTask({ id: "t_1", section: "TODO", createdAt: new Date().toISOString() });
  expect(pickNextTodoTask([justCreated], new Map([["t_1", 0]]))).toBeNull();
});

it("picks a task that has been sitting in TODO", () => {
  const old = makeTask({ id: "t_1", section: "TODO", createdAt: new Date(Date.now() - 120_000).toISOString() });
  expect(pickNextTodoTask([old], new Map([["t_1", 0]]))?.id).toBe("t_1");
});

it("re-verifies eligibility immediately before spawning", async () => {
  // listTasks/readMeta return an eligible task, but by spawn time the
  // task has a coordinator run. autoQueueTick must not spawn.
  ...
  expect(spawnCoordinatorForTask).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bunx vitest run libs/__tests__/autoQueue.test.ts`
Expected: FAIL on all three.

- [ ] **Step 3: Implement both guards**

Add a settling window to `pickNextTodoTask` — a task created within `AUTO_QUEUE_SETTLE_MS` is skipped:

```ts
/** POST /api/tasks writes meta.json (section TODO, runs []) several
 *  awaits — including an LLM detect call — before spawnCoordinatorForTask
 *  appends the first run. A tick landing inside that window saw a task
 *  that looked unclaimed and dispatched a second coordinator (audit C8). */
const AUTO_QUEUE_SETTLE_MS = 120_000;
```

Then re-read the task's meta immediately before spawning in `autoQueueTick` and abort if it is no longer eligible. The settling window alone is a heuristic; the re-check is the real guard. Implement both — the window avoids the wasted read in the common case.

- [ ] **Step 4: Verify and commit**

Run: `bunx vitest run libs/__tests__/autoQueue.test.ts && bun run typecheck && bun run test`

```bash
git add libs/autoQueue.ts libs/__tests__/autoQueue.test.ts
git commit -m "fix(auto-queue): re-verify eligibility before dispatch

Task creation writes meta.json with runs: [] and then awaits an LLM
detect call before appending the coordinator run. A tick inside that
window dispatched a second coordinator for the same task."
```

---

### Task 16: Reserve the repo for the lifetime of a non-worktree run

**Finding (H10, High):** `withGitLock` (`libs/gitOps.ts:170-196`) serialises only the git command sequence itself; it is acquired and released separately inside `prepareBranch`, inside `autoCommitAndPush` and inside `mergeIntoTargetBranch`, so nothing holds a lock across a run's lifetime. `DEFAULT_GIT_SETTINGS` and the UI's recommended preset both default to `worktreeMode: "disabled"` (`libs/apps.ts:135-143`), making this the common configuration. Two runs targeting one app both see a clean tree in `prepareBranch`, both `git checkout -b`, and the second silently moves HEAD out from under the first's child. When either run's `autoCommitAndPush` fires, `git add -A` stages whatever is dirty at that instant — mixing two tasks' diffs into one commit on the wrong branch, with both runs reporting `ok:true`. The existing dedup only rejects an exact `(parentSessionId, role, repo)` match, so differing role names slip through.

**Files:**
- Create: `libs/repoReservation.ts`
- Modify: `app/api/tasks/[id]/agents/route.ts` (dispatch), `libs/runLifecycle.ts` (release on terminal)
- Test: new `libs/__tests__/repoReservation.test.ts`

**Interfaces:**
- Produces: `acquireRepoReservation(repo, sessionId)` / `releaseRepoReservation(repo, sessionId)` / `currentReservation(repo)`.

**Ruling carried into this task:** reservations are in-process and advisory, keyed by app name, and only apply when the app's `worktreeMode` is disabled — worktree-isolated runs are already safe by construction. A reservation must be released on **every** terminal path including crash, and must be reaped by the stale-run reaper so a hard restart cannot deadlock an app forever. Cost if wrong: a stale reservation blocks dispatch to one app until restart; make the error message name the holding session so the operator can act.

- [ ] **Step 1: Write the failing test**

```ts
it("only one session holds a repo at a time", () => {
  expect(acquireRepoReservation("app-a", "s1").ok).toBe(true);
  expect(acquireRepoReservation("app-a", "s2").ok).toBe(false);
});
it("releases so the next session can acquire", () => {
  acquireRepoReservation("app-a", "s1");
  releaseRepoReservation("app-a", "s1");
  expect(acquireRepoReservation("app-a", "s2").ok).toBe(true);
});
it("a second acquire by the SAME session is idempotent", () => {
  acquireRepoReservation("app-a", "s1");
  expect(acquireRepoReservation("app-a", "s1").ok).toBe(true);
});
it("names the holder when it refuses", () => {
  acquireRepoReservation("app-a", "s1");
  expect(acquireRepoReservation("app-a", "s2").heldBy).toBe("s1");
});
```

- [ ] **Step 2: Run to verify it fails, then implement**

Run: `bunx vitest run libs/__tests__/repoReservation.test.ts` → FAIL (module not found), then implement.

- [ ] **Step 3: Wire dispatch and release**

Acquire in the agents route before `prepareBranch`, only when the resolved app has worktree mode disabled. Return 409 naming the holder when refused. Release in `runLifecycle` on every terminal transition — `succeedRun`, `failRun`, and the cancelled path from Task 4 — and add a release to the stale-run reaper's sweep so a restart cannot strand it.

- [ ] **Step 4: Verify and commit**

Run: `bun run typecheck && bun run lint && bun run test`

```bash
git add libs/repoReservation.ts libs/__tests__/repoReservation.test.ts "app/api/tasks/[id]/agents/route.ts" libs/runLifecycle.ts libs/staleRunReaper.ts
git commit -m "fix(git): reserve a non-worktree app for one run at a time

withGitLock only serialises individual git command sequences, so two
runs against one app could both branch from a clean tree and then
cross-stage each other's edits via git add -A."
```

---

## Phase G — Robustness

### Task 17: Validate `meta.json` shape on read

**Finding (H7, High):** `readMeta` (`libs/meta.ts:726-735`) does `JSON.parse(readFileSync(p, "utf8")) as Meta` inside a try/catch that only guards syntax errors. There is no check that `runs` is an array or `taskSection` is a valid member — unlike `libs/profileStore.ts:56-65`, `libs/symbolStore.ts:90-104` and `libs/workflowStore.ts:112-141`, which all validate after parsing. `CLAUDE.md` itself documents a manual fallback ("read `sessions/<task-id>/meta.json`, append a run entry, write the whole file back"), exactly the kind of hand edit that produces a file missing `runs`. `listTasks()` (`libs/tasksStore.ts:140-154`) has no per-task try/catch, so one bad file throws a `TypeError` and takes down `GET /api/tasks` for **every** task.

**Files:**
- Modify: `libs/meta.ts:726-735`, `libs/tasksStore.ts:140-154`
- Test: `libs/__tests__/metaIntake.test.ts` or a new `libs/__tests__/metaValidation.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
it("returns null for structurally invalid meta rather than throwing later", () => {
  writeFileSync(join(dir, "meta.json"), JSON.stringify({ taskTitle: "x" })); // no runs
  expect(readMeta(dir)).toBeNull();
});

it("one corrupt task does not take down the whole task list", () => {
  // one good task dir, one with `{"runs": "not-an-array"}`
  const tasks = listTasks();
  expect(tasks.map((t) => t.id)).toContain("t_good");
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bunx vitest run libs/__tests__/metaValidation.test.ts`
Expected: FAIL — the second throws a `TypeError` out of `listTasks`.

- [ ] **Step 3: Implement**

Add a shape check in `readMeta` mirroring `libs/workflowStore.ts:112-141`'s style. Required at minimum: `runs` is an array, `createdAt` is a string, `taskSection` is one of the known sections. On mismatch, `logWarn` with the path and return `null` — same as a parse failure. Then wrap the per-task body of `listTasks` in a try/catch that skips and warns, so a single bad directory cannot fail the list.

- [ ] **Step 4: Verify and commit**

Run: `bun run typecheck && bun run lint && bun run test`

```bash
git add libs/meta.ts libs/tasksStore.ts libs/__tests__/metaValidation.test.ts
git commit -m "fix(meta): validate shape on read and isolate per-task failures

readMeta only caught JSON syntax errors while every sibling store
validates shape, and listTasks had no per-task guard — so one
hand-edited meta.json took down the entire task list."
```

---

### Task 18: Cap the unbounded transcript reads

**Finding (store review, High):** `readSessionCwd` (`libs/sessions.ts:542-554`) does `readFileSync(filePath, "utf8").slice(0, 16384)` — loading the **entire** transcript to keep 16 KB. `sumUsageFromJsonl` (`libs/sessionUsage.ts:80-136`, read at :107) loads the whole file to sum per-line usage. Both sit in the same modules as `tailJsonl`/`scanSessionHeadUncached`, which deliberately chunk (256 KB / 16 KB windows, 4 MB cap) to avoid exactly this. `readSessionCwd` is reached from `discoverOrphanProjects`, hit by `GET /api/sessions/all` and `GET /api/sessions/[sessionId]` with only a ~2s cache. `sumUsageFromJsonl` keys its cache on `(path, mtime, size)`, so for an **actively running** task every `/usage` poll misses and re-reads the whole growing file synchronously, blocking the event loop.

**Files:**
- Modify: `libs/sessions.ts:542-554`, `libs/sessionUsage.ts:80-136`
- Test: `libs/__tests__/sessionUsage.test.ts` (extend)

- [ ] **Step 1: Write the failing test**

```ts
it("reads only the head of a large transcript", () => {
  const big = join(dir, "big.jsonl");
  writeFileSync(big, JSON.stringify({ cwd: "/repo/app", type: "x" }) + "\n" + "x".repeat(20_000_000));
  const spy = vi.spyOn(fs, "readFileSync");
  expect(readSessionCwd(big)).toBe("/repo/app");
  // The whole 20 MB must not be pulled into memory.
  expect(spy).not.toHaveBeenCalledWith(big, "utf8");
});
```

- [ ] **Step 2: Run to verify it fails, then implement**

Read `scanSessionHeadUncached` in the same file and reuse its chunked-read approach for `readSessionCwd`. For `sumUsageFromJsonl`, stream line-by-line rather than materialising the file, and keep the existing cache key.

- [ ] **Step 3: Verify and commit**

Run: `bun run typecheck && bun run lint && bun run test`

```bash
git add libs/sessions.ts libs/sessionUsage.ts libs/__tests__/sessionUsage.test.ts
git commit -m "perf(sessions): stop loading whole transcripts to read a prefix or sum usage

Both functions sit beside chunked readers written to avoid exactly this;
the usage cache also misses on every poll of a running task, so each
poll re-read the entire growing file synchronously."
```

---

### Task 19: Count distinct files in the read-before-edit gate

**Finding (M5, Medium):** `countReadsBeforeEdit` (`libs/preflightCheck.ts:66-101`) increments on every `Read`/`Grep`/`Glob`/`LS` tool_use block before the first edit, with no de-duplication by path. `DEFAULT_MIN_READS_BEFORE_EDIT = 3` (:185-193) is therefore satisfied by one `Glob` plus two `Read`s of the same file — the check cannot distinguish "studied three relevant files" from "reread one file three times", and it is the sole signal gating the comprehension retry.

**Files:**
- Modify: `libs/preflightCheck.ts:66-101`
- Test: `libs/__tests__/preflightCheck.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
it("counts distinct files, not tool calls", () => {
  const entries = [
    toolUse("Read", { file_path: "/a.ts" }),
    toolUse("Read", { file_path: "/a.ts" }),
    toolUse("Read", { file_path: "/a.ts" }),
    toolUse("Edit", { file_path: "/a.ts" }),
  ];
  expect(countReadsBeforeEdit(entries)).toBe(1);
});
```

- [ ] **Step 2: Run to verify it fails, then implement**

Collect normalised `input.file_path` (and `input.pattern` for Grep/Glob) into a `Set` and return its size. Normalise case only on Windows, matching whatever the rest of the file does for paths.

- [ ] **Step 3: Verify and commit**

Run: `bun run typecheck && bun run lint && bun run test`

```bash
git add libs/preflightCheck.ts libs/__tests__/preflightCheck.test.ts
git commit -m "fix(preflight): count distinct files read, not tool calls

The threshold was satisfiable by rereading one file three times, so the
sole read-before-edit comprehension signal was mechanically gameable."
```

---

### Task 20: Feed summary staleness into the coordinator finalizer

**Finding (gates High #4):** `evaluateAndNudge` computes `summaryStale` specifically to fix the documented "round 2 goes silent" bug, but feeds it only into the *resume* decision, not the earlier *finalize* decision. Verified: `shouldFinalizeDeferredCoordinator` (`libs/coordinatorNudge.ts:197-215`) accepts `summaryMissing?` and has **no `summaryStale` parameter at all**; its call site (`:549-556`) passes only `summaryMissing`, while `decideNudge`'s call site (`:585-594`) passes both. So when a coordinator ships a round-1 summary and exits, and round-2 children later finish, `summaryMissing` is `false` (the file exists), the finalizer returns `true`, and the coordinator run flips straight to `done` carrying the **stale round-1 summary** — before the staleness-aware resume ever runs. If that resume then fails (`resumeSessionWithLifecycle` → `resumeClaude` is unguarded against a synchronous throw beyond `evaluateAndNudge`'s catch-and-log at `:651-675`), the coordinator sits at `done` permanently with round-2 work unaccounted for in the "READY FOR REVIEW" summary the operator actually reads.

**Files:**
- Modify: `libs/coordinatorNudge.ts:197-215` (signature + guard), `:549-556` (call site)
- Test: `libs/__tests__/coordinatorNudge.test.ts`

**Interfaces:**
- Consumes: `isSummaryStale(...)` — already exported from the same file (`:123-151`) and already computed in `evaluateAndNudge`.
- Produces: `shouldFinalizeDeferredCoordinator` gains an optional `summaryStale?: boolean` argument, mirroring the existing `summaryMissing?: boolean` exactly.

- [ ] **Step 1: Write the failing test**

`libs/__tests__/coordinatorNudge.test.ts` already exercises `shouldFinalizeDeferredCoordinator`; add beside those tests, matching their existing arrangement helpers:

```ts
it("does not finalize a coordinator whose summary is stale", () => {
  expect(
    shouldFinalizeDeferredCoordinator({
      parentSessionId: "coord-1",
      runs: [
        { sessionId: "coord-1", role: "coordinator", status: "running" },
        { sessionId: "child-1", role: "coder", status: "done", parentSessionId: "coord-1" },
      ] as Run[],
      isAlive: () => false,
      summaryMissing: false,
      summaryStale: true,
    }),
  ).toBe(false);
});

it("still finalizes when the summary is present and fresh", () => {
  expect(
    shouldFinalizeDeferredCoordinator({
      parentSessionId: "coord-1",
      runs: [
        { sessionId: "coord-1", role: "coordinator", status: "running" },
        { sessionId: "child-1", role: "coder", status: "done", parentSessionId: "coord-1" },
      ] as Run[],
      isAlive: () => false,
      summaryMissing: false,
      summaryStale: false,
    }),
  ).toBe(true);
});
```

The second test is the regression guard — it must stay passing, or the fix has simply disabled finalization.

- [ ] **Step 2: Run the test to verify it fails**

Run: `bunx vitest run libs/__tests__/coordinatorNudge.test.ts`
Expected: the first test FAILS (returns `true`), and it fails at typecheck first because `summaryStale` is not in the parameter type. Both are correct first failures.

- [ ] **Step 3: Implement**

Add the parameter and the guard immediately after the existing `summaryMissing` guard at `:208`, so the two read as a pair:

```ts
export function shouldFinalizeDeferredCoordinator(args: {
  parentSessionId: string;
  runs: Run[];
  isAlive: (sessionId: string) => boolean;
  summaryMissing?: boolean;
  summaryStale?: boolean;
}): boolean {
```

```ts
  if (args.summaryMissing === true) return false;
  // A summary that exists but predates the latest round of child work
  // is not a finished report. evaluateAndNudge already computes this
  // and feeds it to decideNudge; the finalizer never received it, so a
  // coordinator could flip to `done` carrying a stale round-1 summary
  // before the staleness-aware resume ran at all (audit gates H4).
  if (args.summaryStale === true) return false;
```

Then pass it at the call site (`:549-556`), beside the `summaryMissing` already there:

```ts
    shouldFinalizeDeferredCoordinator({
      parentSessionId,
      runs: meta.runs,
      isAlive,
      summaryMissing,
      summaryStale,
    })
```

Confirm `summaryStale` is in scope at that call site — it is computed before the `decideNudge` call at `:585`. If it is computed *after* the finalize call, hoist the computation above the finalize branch rather than recomputing it, and say so in your report file.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bunx vitest run libs/__tests__/coordinatorNudge.test.ts`
Expected: PASS, including the existing finalizer tests.

- [ ] **Step 5: Verify and commit**

Run: `bun run typecheck && bun run lint && bun run test`

```bash
git add libs/coordinatorNudge.ts libs/__tests__/coordinatorNudge.test.ts
git commit -m "fix(coordinator): don't finalize a coordinator whose summary is stale

evaluateAndNudge computes summaryStale for the resume decision but the
finalizer never received it, so a coordinator could flip to done with a
stale round-1 summary while round-2 work went unreported."
```

---

## Phase H — Frontend

### Task 21: Accessibility and the status-refetch race

Batched: both are small, both in components, one review surface.

**Finding (M7, Medium):** `ThinkingBlockView`, `BashToolUseView`, `ToolUseView` and `ToolResultView` (`app/_components/SessionLog/views.tsx:290,326,708,796`) and `DiffViewer.tsx:813`'s `TreeItem` each render a `<button onClick={() => setOpen(v => !v)}>` that shows/hides content with no `aria-expanded`. Verified: `views.tsx` contains 0 occurrences, while `AppDetail.tsx` does it correctly. Screen-reader users get a button with visible text but no disclosure semantics or state.

**Finding (UI Medium 3):** `reloadStatus` (`app/_components/AppDetail.tsx:112-121`) creates an `AbortController` and returns `() => ac.abort()`, but only the `useEffect` call site at :122 wires that cleanup up. The Refresh button (:132) and `onMaybeChangedRepo` (:168-174, fired after every one-shot terminal command at :852) call it directly and discard the aborter. `TerminalPanel.submit` (:824-867) has no in-flight guard and clears the draft immediately, so a user can submit a second command before the first resolves; both completions trigger uncancelled `api.appStatus` requests that can resolve out of order, leaving stale branch/dirty badges.

**Files:**
- Modify: `app/_components/SessionLog/views.tsx`, `app/_components/DiffViewer.tsx`, `app/_components/AppDetail.tsx`

- [ ] **Step 1: Add `aria-expanded` to all five toggles**

For each of the five buttons, add `aria-expanded={open}` (using each component's own open-state variable name). Where the button controls a specific region that already has an id, also add `aria-controls`; do not invent ids where none exist. Change nothing else — no restyling, no restructuring.

- [ ] **Step 2: Make status refetch race-proof**

In `AppDetail.tsx`, hold the active `AbortController` in a `useRef` shared by all three call sites: abort the previous controller before starting a new request. Then guard `TerminalPanel.submit` with an in-flight flag that disables the submit control while a command is pending — this removes both the UX ambiguity and the second source of concurrent refetches.

- [ ] **Step 3: Verify in the browser**

Run `bun run dev`, open an app detail page, and confirm: the toggles still open/close; rapid Refresh clicks leave correct badges; the terminal submit disables while a command runs. Record what you observed in your report file — these changes have no unit tests, so the manual check *is* the evidence.

- [ ] **Step 4: Verify and commit**

Run: `bun run typecheck && bun run lint`
Expected: 0 errors, and the pre-existing warning count must not grow.

```bash
git add app/_components/SessionLog/views.tsx app/_components/DiffViewer.tsx app/_components/AppDetail.tsx
git commit -m "fix(ui): disclosure semantics on five toggles; cancel superseded status refetches

views.tsx had no aria-expanded at all while AppDetail.tsx already did it
correctly. reloadStatus returned an aborter that two of its three call
sites discarded, so out-of-order responses left stale git badges."
```

---

### Task 22: Virtualize the log list and the diff pane

**Finding (M6, Medium):** `SessionLog.tsx:1532` renders every loaded entry (`MAX_RENDERED = 300`, `SessionLog/helpers.ts:162`) directly into the DOM and `DiffViewer.tsx:910-926`'s `FileDiffPane` renders every hunk line of the selected file in one `<pre>` with no line cap. Verified: the repo has no virtualization library. The `key={sessionId}` remount re-lays-out the whole tree on every session switch. Bounded (300-row cap, per-file pagination, 256 KB server-side truncation) so impact is moderate: scroll jank and slow session switches on long sessions.

**Files:**
- Modify: `package.json`, `app/_components/SessionLog.tsx`, `app/_components/DiffViewer.tsx`
- Test: manual — measure before and after

**Ruling carried into this task:** add `@tanstack/react-virtual` (headless, ~4 KB, no styling opinions) rather than hand-rolling a windowing implementation. Apply it **only above a threshold** — below ~80 rows, virtualization costs more than it saves and complicates the scroll-pinning logic `SessionLog` already has. Cost if wrong: one new dependency; if it proves unnecessary the change reverts cleanly because the non-virtual path stays.

- [ ] **Step 1: Measure first**

Open a session with several hundred entries. Record in your report file: time to switch sessions, and whether scrolling drops frames (DevTools Performance). **If you cannot produce a session that janks, stop and report that** — do not add a dependency to fix an unmeasured problem. This step can legitimately end the task.

- [ ] **Step 2: Add the dependency**

Run: `bun add @tanstack/react-virtual`

- [ ] **Step 3: Virtualize above a threshold**

In `SessionLog.tsx`, keep the existing direct `.map()` when `visibleEntries.length < VIRTUALIZE_THRESHOLD` (80) and use the virtualizer above it. `SessionLog` has autoScroll, a `ResizeObserver` re-pin and an `IntersectionObserver`-driven pinned header (:1084-1180) — all three interact with scroll position, so verify each still behaves after the change. Do the same for `FileDiffPane`'s line list.

- [ ] **Step 4: Measure again and verify behaviour**

Re-run the Step 1 measurement and record both numbers. Then confirm manually: autoScroll still pins to the bottom on new entries; scrolling up stops the pin; the pinned user-message header still appears; Ctrl+F search still scrolls to matches. Record each in your report file. **Search-to-match is the most likely regression** — a virtualized row that is not rendered cannot be scrolled to without the virtualizer's `scrollToIndex`.

- [ ] **Step 5: Verify and commit**

Run: `bun run typecheck && bun run lint && bun run test`

```bash
git add package.json bun.lock app/_components/SessionLog.tsx app/_components/DiffViewer.tsx
git commit -m "perf(ui): virtualize the log list and diff pane above a row threshold

Both rendered every row into the DOM, and the key={sessionId} remount
re-laid-out the whole tree on each session switch."
```

---

## Phase I — Structural splits

These two tasks change no behaviour. They carry the highest regression risk in the plan precisely because they touch the most code, so they run last, separately, and each is reviewed on its own.

### Task 23: Split `libs/apps.ts`

**Finding (M1, Medium):** 2,379 lines — the largest file in the repo — mixing five responsibilities, three of which (Telegram settings, tunnel/detect/public-URL settings, repo-scanning heuristics) have nothing to do with the apps registry and merely share `bridge.json` as a persistence target.

**Files:**
- Create: `libs/apps/types.ts`, `libs/apps/manifest.ts`, `libs/apps/crud.ts`, `libs/bridgeSettings.ts`, `libs/telegramSettings.ts`, `libs/repoDetect.ts`
- Modify: `libs/apps.ts` → barrel re-export

**Interfaces:**
- Produces: `libs/apps.ts` must keep re-exporting its entire current public surface. ~60 files import from `@/libs/apps`; **none of them may change in this task.**

| Module | Source lines | Contents |
|---|---|---|
| `libs/apps/types.ts` | 46-421 | `AppGitSettings`, `AppVerify`, `AppQuality`, `AppRetry`, `AppMemory`, `AppDispatch`, `SpeculativeAngle`, `App`, `ManifestAppEntry`, `BridgeManifest`, all `DEFAULT_*`, plus `semanticVerifierEnabled` / `resolvePanelSize` / `resolveCriticPanelSize` |
| `libs/apps/manifest.ts` | 423-938 | `isValidAppName`, `resolveAppPath`, `readManifest`, all `normalize*`/`serialize*`, `parseApps`, `parseAppsFromManifest`, `serializeApps`, `loadApps`, `saveApps` + the 1s cache |
| `libs/apps/crud.ts` | 940-1270, 1843-1954 | `getApp`, `resolveAppFromRouteSegment`, `applyRecommendedPreset`, `addApp`, `removeApp`, `updateAppDescription`, `updateAppGitSettings`, `updateAppVerify`, `isVerifyEmpty`, `backfillAppVerifyIfEmpty`, `updateAppCapabilities`, `updateAppQuality`, `updateAppRetry`, `renameApp` |
| `libs/bridgeSettings.ts` | 1272-1426, 2346-2379 | `getManifestDetectSource`/`set…`, `getManifestPublicUrl`/`set…` (+`normalizePublicUrl`), `getTunnelAutoStart`/`set…`, `getManifestDetectScanRoots`/`set…` |
| `libs/telegramSettings.ts` | 1428-1841 | all `Telegram*` types + normalize + `getManifestTelegramSettings`/`set…` |
| `libs/repoDetect.ts` | 1957-2344 | `scoreRepo`, `deriveDescription`, `formatRawPath`, `suggestAppName`, `DetectCandidate`, `DetectEvent`, `DetectOptions`, `detectAppCandidates`, `AutoDetectResult`, `autoDetectApps` |

- [ ] **Step 1: Establish the safety net**

Run `bun run test` and record the exact pass count in your report file. That number must be identical at the end. Confirm the current public surface: `grep -n "^export" libs/apps.ts > /tmp/apps-exports-before.txt`.

- [ ] **Step 2: Move one module at a time, verifying between each**

Do the six moves in the table's order (types first — everything else depends on it). After **each** move: `bun run typecheck && bun run test`. Do not batch the moves; a single failing move is trivial to locate, six at once is not.

Move code **verbatim**. No renaming, no signature changes, no "while I'm here" cleanups. Any behaviour change here is invisible to review because it hides in a large mechanical diff.

- [ ] **Step 3: Confirm the barrel is complete**

Run `grep -n "^export" libs/apps.ts > /tmp/apps-exports-after.txt` and diff against the before file. The exported *names* must match exactly. Record the diff (or its absence) in your report file.

- [ ] **Step 4: Verify and commit**

Run: `bun run typecheck && bun run lint && bun run test`
Expected: identical pass count to Step 1.

```bash
git add libs/apps.ts libs/apps libs/bridgeSettings.ts libs/telegramSettings.ts libs/repoDetect.ts
git commit -m "refactor(apps): split libs/apps.ts into six focused modules

2379 lines mixing the apps registry with Telegram settings, tunnel and
detect settings, and repo-scan heuristics — three domains that only
shared bridge.json as a persistence target. apps.ts stays a barrel so
no call site changes."
```

---

### Task 24: Split `app/_components/SessionLog.tsx`

**Finding (M2, Medium):** 1,642 lines mixing six responsibilities: the SSE stream lifecycle (:475-743), backward pagination (:745-820, :1049-1059), scroll orchestration (:1084-1180), chat search (:854-947, :1298-1357), derived aggregates (:949-1000, :1216-1255), and the `LogRow` orchestrator plus a ~200-line header JSX block (:61-269, :271-408, :1358-1495).

**Files:**
- Create: `app/_components/SessionLog/useSessionStream.ts`, `useScrollManager.ts`, `useChatSearch.ts`, `SessionLogHeader.tsx`, `StreamingRows.tsx`
- Modify: `app/_components/SessionLog.tsx`

**Interfaces:**
- `useSessionStream(...)` returns `{ entries, trimmed, activity, aliveSse, lastTs, loadOlder, loadingOlder, handleRewind, onSent }`.
- `useScrollManager(...)` returns `{ autoScroll, scrollToBottom, pinnedUserUuid, pinnedUserText, handleScroll }`.
- `useChatSearch(...)` returns `{ searchOpen, searchQuery, matchIdx, searchIndex, matchedKeys, setSearchQuery, next, prev, close }`.

**Constraint specific to this task:** `next.config.ts` sets `reactStrictMode: true`, and the audit **verified** that the SSE effect and `useEventSource` survive double-mount via a per-invocation `stopped` flag checked after every `await`, with `offsetRef`/`firstOffsetRef` preventing replay. **That property must survive the extraction.** When moving the SSE effect into a hook, keep the `stopped` flag and the refs exactly as they are — do not "simplify" them.

- [ ] **Step 1: Extract `StreamingRows.tsx` first**

`StreamingPartialsList`, `StreamingPartialRowConnected`, `SpawnPlaceholder` and `EmptyOrStreaming` are already self-contained and depend only on `partialsStore` plus props. Move them verbatim, then `bun run typecheck && bun run lint`. This is the lowest-risk move and proves the file layout works.

- [ ] **Step 2: Extract `useChatSearch.ts`**

Move the search state, `searchIndex`/`matchedKeys` memoization, highlight-timer cleanup and the Cmd/Ctrl+F keydown listener. Keep the timer cleanup wired to the hook's own effect teardown.

- [ ] **Step 3: Extract `useScrollManager.ts`**

Move autoScroll tracking, `scrollToBottom`, the `ResizeObserver`/`IntersectionObserver` pair, and `handleScroll`. Verify manually after this step: autoScroll pins on new entries, scrolling up releases the pin, the pinned user-message header still appears.

- [ ] **Step 4: Extract `useSessionStream.ts`**

The largest and most side-effect-heavy move. Preserve the `stopped` flag and both offset refs verbatim. After the move, verify manually with the dev server that a live session still streams, that reconnect-after-background works, and that `loadOlder` still restores scroll position.

- [ ] **Step 5: Extract `SessionLogHeader.tsx`**

Move the `<header>` JSX as a presentational component taking the hooks' outputs as props.

- [ ] **Step 6: Verify**

Run: `bun run typecheck && bun run lint && bun run test`

Then a full manual pass with `bun run dev`: open a long session, scroll up to paginate, use Ctrl+F, toggle tools, export, and confirm a live run streams. Record each in your report file — there are no unit tests for this component, so the manual pass is the only evidence.

- [ ] **Step 7: Commit**

```bash
git add app/_components/SessionLog.tsx app/_components/SessionLog
git commit -m "refactor(SessionLog): split six responsibilities into hooks and components

1642 lines mixing SSE lifecycle, pagination, scroll orchestration, chat
search, derived aggregates and a 200-line header. The StrictMode
double-mount guards (stopped flag + offset refs) move verbatim."
```

---

## Phase J — added during execution

### Task 25: Act on the worktree merge-back result at the automatic call site

**Added after Task 7, whose implementer was asked to investigate this and confirmed it.** Not in the original plan; discovered because Task 7's finding text named it and the investigation settled it.

**Finding (verified twice — by Task 7's implementer and independently by its reviewer):** `libs/runLifecycle.ts:1049` is `await performWorktreeMergeBack({ app, run, tid, title, t, dir, message });` — the result is **discarded**. Forty lines away, the human-facing ship route does it correctly: `app/api/tasks/[id]/runs/[sessionId]/confidence/review/route.ts:99-125` checks `mb.stage === "merge"`, retains the confidence hold, and returns a structured error carrying the comment *"clearing the hold here would be irreversible."*

So after Task 7, a conflicting merge-back now aborts cleanly and keeps the worktree — but at the automatic call site **nothing is stamped on the run and nothing reaches the operator**. The work sits in a worktree nobody is told about, and the run reads as if the merge-back succeeded.

**Files:**
- Modify: `libs/runLifecycle.ts:1049` (capture and act on the result)
- Test: `libs/__tests__/runLifecycle.test.ts`

**Interfaces:**
- Consumes: `performWorktreeMergeBack(...)`'s return value — read its actual type before writing; Task 7's reviewer confirmed it carries at least `ok` and `stage`, with `stage === "merge"` distinguishing a merge failure from a later cleanup failure.
- Consumes: `Run.mergeNotPushed` — the existing "DONE but needs attention" marker shape. Check whether it fits, or whether a sibling field is the better precedent.

**Ruling carried into this task:** mirror what the ship route already does rather than inventing a new signal. A merge-stage failure must (a) be stamped on the run so the UI and `gateStatus` can surface it, and (b) reach the operator through the same escalation path other blocked gates use. Do **not** make the automatic path attempt any recovery the human path does not — the ship route's refusal to clear an unlanded hold is the correct instinct and this task must not soften it.

- [ ] **Step 1: Write the failing test**

Add to `libs/__tests__/runLifecycle.test.ts`, mirroring the harness the gate-crash tests already use:

```ts
it("stamps the run and escalates when the automatic merge-back conflicts", async () => {
  worktreesMock.mergeAndRemoveWorktree.mockResolvedValue({
    ok: false,
    stage: "merge",
    message: "merge of claude/x into main failed (aborted; worktree kept at /tmp/wt)",
  });

  await runPostExitGates(ctx);

  const meta = readMeta(dir);
  const run = meta!.runs.find((r) => r.sessionId === ctx.run.sessionId);
  expect(run?.mergeNotPushed ?? run?.mergeConflict).toBeTruthy();
  expect(escalateGateBlockSpy).toHaveBeenCalled();
});
```

Read the real return type and the real marker field first and replace the `??` above with whichever one you are actually setting — that alternation is there because the shape must be confirmed, not guessed.

- [ ] **Step 2: Run the test to verify it fails**

Run: `bunx vitest run libs/__tests__/runLifecycle.test.ts`
Expected: FAIL — nothing is stamped and no escalation fires, because the result is discarded.

- [ ] **Step 3: Capture and act on the result**

Assign the call's result, and on `!result.ok` with a merge-stage failure, stamp the run and escalate. Reuse `escalateGateBlock` from `libs/gateEscalation.ts` exactly as the gate crash branches do — lazy import, independent try/catch per side effect, `retryScheduled: false`.

Add a comment naming why the automatic path must not stay silent: the worktree holds the only copy of the work and nothing else will tell the operator it exists.

- [ ] **Step 4: Run the test to verify it passes**

Run: `bunx vitest run libs/__tests__/runLifecycle.test.ts`

- [ ] **Step 5: Full verification**

Run: `bun run typecheck && bun run lint && bun run test`

- [ ] **Step 6: Commit**

```bash
git add libs/runLifecycle.ts libs/__tests__/runLifecycle.test.ts
git commit -m "fix(worktrees): act on the merge-back result at the automatic call site

Task 7 made a conflicting merge-back abort cleanly and keep the worktree,
but the automatic caller discarded the result — so nothing was stamped on
the run and nothing reached the operator. The ship route 40 lines away
already handled this correctly."
```

---

### Task 26: Actually render the `mergeNotPushed` marker

**Added during execution, after Task 8's re-review observed it and I verified it.** Not in the original plan.

**Finding (verified by grep):** `run.mergeNotPushed` is written in at least three places — `libs/runLifecycle.ts:188`, the worktree push-stage path, and (after Tasks 7/8/25) the confidence-review ship path — and **read by none**. A repo-wide search of `app/` for `mergeNotPushed` returns exactly one hit, and it is a comment. Meanwhile `libs/client/types.ts:44-49` documents a yellow "needs-push badge" that no component implements.

**Why this matters more than its size suggests:** Tasks 7, 8 and 25 exist to make sure the operator learns that work landed locally but did not ship, or that a merge-back conflicted and the worktree is holding the only copy. All three stamp this marker. **The operator never sees it.** Until this task lands, the "tell the operator" half of those three fixes is inert — the state is recorded correctly and displayed nowhere. This is the plan's own central theme (a mechanism built and not wired) reproduced inside the remediation itself.

**Files:**
- Modify: whichever component renders run rows — start from `app/_components/AgentTree.tsx` and `app/_components/TaskDetail.tsx`, and follow how a sibling marker (e.g. the confidence hold, or `run.status`) is surfaced today
- Modify: `libs/client/types.ts` if the client-side `Run` type does not carry the field
- Test: manual — this is UI with no existing route/component test convention

**Interfaces:**
- Consumes: `Run.mergeNotPushed` as defined at `libs/meta.ts:146` — read the actual shape (`{ message, ... }`) before rendering it; do not assume.

**Ruling carried into this task:** render it where a run's status is already shown, reusing whatever badge/pill primitive that surface already uses. Do **not** build a new component or introduce a new colour token — `libs/client/types.ts:44-49` says "yellow", so use the existing warning token if one exists, and say so if it does not. The marker's `message` already contains the operator's recovery instruction (`MERGE-NO-PUSH:` or `SHIP-INCOMPLETE:` plus the underlying git message), so surface that text rather than writing new copy.

- [ ] **Step 1: Establish what is actually true**

Run: `grep -rn "mergeNotPushed" app/ libs/ --include=*.ts --include=*.tsx | grep -v __tests__`

Record the writers and the (expected zero) readers in your report. If a reader does exist and the earlier grep was wrong, **stop and report that** — the task is then unnecessary and should not be invented into existence.

- [ ] **Step 2: Find the surface**

Read how `run.status` and the confidence hold are rendered in `app/_components/AgentTree.tsx` and `app/_components/TaskDetail.tsx`. Pick the one where an operator scanning a task would actually look. State your choice and why in your report.

- [ ] **Step 3: Check the client type carries the field**

If `libs/client/types.ts`'s run type lacks `mergeNotPushed`, add it, matching `libs/meta.ts:146`'s shape exactly. Note that `libs/client/types.ts` has drifted from the server types before in this plan (Task 1 found its `semanticVerifier` union missing `"crashed"`), so check rather than assume.

- [ ] **Step 4: Render it**

Add the badge using the existing primitive. The tooltip or expanded text shows `mergeNotPushed.message` verbatim.

- [ ] **Step 5: Verify in the browser**

Run `bun run dev`, and construct a run carrying the marker — the cheapest way is to hand-edit a `sessions/<task-id>/meta.json` run entry to add a `mergeNotPushed` object, since reproducing a real push failure is expensive. Confirm the badge appears and the message is readable. **Record what you saw** — there is no unit test for this, so the manual check is the only evidence. Stop the dev server when done.

- [ ] **Step 6: Verify and commit**

Run: `bun run typecheck && bun run lint`

```bash
git add app/_components libs/client/types.ts
git commit -m "feat(ui): surface the mergeNotPushed marker

Three code paths stamp this marker so the operator learns work landed
locally but did not ship, or that a merge-back conflicted and a worktree
holds the only copy. Nothing rendered it — the state was recorded
correctly and displayed nowhere."
```

---

## Deferred — not in this plan

Recorded so the final review does not treat them as oversights:

- **`~/.claude/bridge.json` stores secrets in plaintext** (bot token, auth secret, internal token, password hash). Out of scope: it is an operator-environment change, not a code change, and moving it into an OS credential store is its own design decision.
- **The unexplained auto-commit + push to `origin/main`** and `core.hooksPath` pointing at `edusoft-lms-bridge`. Operator-owned configuration; flagged, not fixed.
- **`AskUserQuestion` back-answering** (only the most recent question is answerable) — the audit found this is a deliberate tradeoff documented in the code, not a defect.
- **CSP `unsafe-inline` / `unsafe-eval`** — acknowledged tech debt in `next.config.ts`; removing it needs a nonce-aware build pipeline, which is a project of its own.
- **Test coverage for `heartbeat.ts`, `inFlight.ts`, `spawnRegistry.ts`, and `processKill.ts`'s Windows branch** — real gaps, but adding tests to unchanged code is separable from this remediation.

---

## Execution notes

- Tasks 1-6 are the highest value and should not be reordered — Phase A defines whether every later task's work can be trusted.
- **Do not enable auto-queue until Phase F lands.**
- Task 22 Step 1 can legitimately end that task with "not reproducible"; that is a valid outcome, not a failure.
- Tasks 23 and 24 change no behaviour. If either produces a diff that is not purely mechanical, that is a defect.
- Task 20 is independent of every other task and may be reordered freely if it helps batching.
