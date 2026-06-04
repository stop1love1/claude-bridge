# Reliability Amplifier (Epic B1) — Design

- **Date:** 2026-06-04
- **Status:** Approved (centerpiece + cost model by operator; remaining details delegated to Claude)
- **Epic:** B1 of the roadmap (A. Planning Gate ✅ → **B. Reliability Amplifier** → C. Live Preview → D. Multi-coder). B1 = multi-judge panel + self-review + default-on. B2 (confidence score + human escalation) is a separate later spec.
- **Owner repo:** `claude-bridge` (this repo).

## Problem

The bridge already runs a 5-gate verify-then-ship chain (verify chain → preflight →
claim-vs-diff → style critic → semantic verifier) with a per-gate retry ladder. But the two
**agent-driven** gates — `style-critic` and `semantic-verifier` — are **single-judge**: one
agent's verdict decides whether the diff ships. A single judge has blind spots; a
plausible-but-wrong change can pass because the one judge didn't probe the angle that would
have caught it. Agents also tend to self-report "done" without a deliberate self-review
pass. Result: occasional false-greens reach the operator.

## Goal

Amplify the **semantic** gate from one judge into a **3-judge panel with diverse lenses and
majority consensus**, add a mandatory **coder self-review** before the report, and make
semantic verification **on by default**. Reuse the existing `runAgentGate` runner and the
`RunSemanticVerifier` result shape so the retry/commit plumbing is unchanged.

## Policy (locked with operator)

- **Panel default = 3 judges, diverse lenses, majority.** A diff is blocked (`broken`) when
  **≥ 2 of 3** judges return `broken`. Cost ≈ 3× the semantic gate's tokens — accepted for
  quality. Panel size is configurable per app.
- **Self-review is mandatory** (prompt-level, no extra spawn).
- **Default-on:** semantic verification runs even when an app hasn't explicitly opted in;
  apps can still turn it off or change the panel size.

## Architecture

Reuse `runAgentGate(opts)` (libs/qualityGate.ts) verbatim — it already spawns one judge,
waits, and returns the parsed verdict JSON. The panel calls it **N times concurrently** with
a per-lens brief and a distinct verdict filename, then aggregates by majority.

### Components

**New**
- `libs/judgePanel.ts` — `runJudgePanel(opts)`: fan out N `runAgentGate` calls (one per
  lens) via `Promise.all`, parse each verdict with the existing `parseSemanticVerdict`, and
  `aggregatePanel(verdicts)` → `{ verdict, reason, concerns, votes }`. Pure aggregation
  (`aggregatePanel`) is unit-tested in isolation.
- `prompts/playbooks/semantic-verifier.md` gains nothing new (reused per-lens via the
  brief); the lens nudges live in `judgePanel.ts`.

**Modified**
- `libs/semanticVerifier.ts` — `runSemanticVerifier` calls `runJudgePanel` when the
  resolved panel size ≥ 2 (default), else the existing single `runAgentGate` (back-compat
  for `verifierPanel: 1`). Result stays a `RunSemanticVerifier` (now carrying `votes`).
- `libs/meta.ts` — extend `RunSemanticVerifier` with optional
  `votes?: Array<{ lens: string; verdict: "pass"|"drift"|"broken"; reason: string }>` and
  `panelSize?: number`. Absent on legacy rows / single-judge runs.
- `libs/apps.ts` — `AppQuality` gains `verifierPanel?: number` (1–5, default 3). Resolve
  the **default-on** flip here: a helper `semanticVerifierEnabled(app)` returns true unless
  `quality.verifier === false` explicitly.
- `libs/runLifecycle.ts` (postExitFlow semantic gate) — gate eligibility uses
  `semanticVerifierEnabled(app)` instead of `app.quality?.verifier === true`, so the gate is
  default-on.
- `prompts/report-template.md` — add a mandatory **Self-review** step before the report
  contract: re-read your own `git diff HEAD`, act as a hostile reviewer, list what you'd
  flag, fix it, then write the report. (Canonical copy; `libs/childPrompt.ts` injects it
  into every child.)

### Lenses (3, fixed for v1)

| Lens key | Question the judge probes |
|---|---|
| `correctness` | Does the diff actually satisfy the task body's acceptance criteria? |
| `edge-cases` | Find an input / state the diff handles wrong — boundaries, empties, errors. Try to break it. |
| `regression` | Does this break existing behavior or open an input/boundary risk elsewhere? |

Each lens gets the same base brief (re-read task + report, `git diff HEAD`) plus a one-line
lens nudge, and a distinct verdict file (`semantic-verdict-<lensKey>.json`). All three runs
keep `role: "semantic-verifier"` so the existing playbook loads; they render as three
sibling judge runs in the tree.

### Aggregation (`aggregatePanel`)

Inputs: the N parsed verdicts (skipped judges drop out). Rule:
- `brokenCount = #{verdict === "broken"}`. If `brokenCount >= ceil(N/2)` → **`broken`**.
- else if `brokenCount >= 1` **or** any `verdict === "drift"` → **`drift`** (a *minority*
  `broken` vote is overruled on the block decision but still downgrades to `drift` so its
  concerns surface for review — it never silently vanishes into `pass`).
- else → **`pass`**.
- If fewer than `ceil(N/2)` judges produced a usable verdict (skips/crashes) → fall back to
  `skipped` (fail-soft: commit proceeds, surfaced in meta) — never block on an inconclusive
  panel.
- `reason` = synthesized: the majority-side judges' reasons joined; `concerns` = de-duped
  union of the blocking/drift judges' concerns (cap 10). `votes` records every lens's
  verdict + reason for UI transparency.

Block (`broken`) → existing `spawnSemanticVerifierRetry` (`-svretry`) fires exactly as
today; the retry re-runs the panel (bounded by the per-gate retry budget + per-task ceiling).

### Data flow

```
coder exits → postExitFlow → (verify chain, preflight, claim-vs-diff, style critic) →
  semantic gate (default-on):
    runSemanticVerifier → runJudgePanel(N=3)
        ├─ runAgentGate(lens=correctness, file=…-correctness.json)  ┐ concurrent
        ├─ runAgentGate(lens=edge-cases,  file=…-edge-cases.json)   │ (Promise.all)
        └─ runAgentGate(lens=regression,  file=…-regression.json)   ┘
      aggregatePanel(verdicts) → {verdict, reason, concerns, votes}
    broken (≥2/3) → block commit + spawn -svretry (unchanged plumbing)
    drift/pass    → commit proceeds (drift surfaced in meta as today)
```

Self-review happens earlier, inside the coder's own turn (prompt-level), so the panel
judges already cleaner diffs.

## Error handling & edge cases

- **A judge skips/crashes/times out** → that lens drops out; aggregation uses the rest.
  Inconclusive (< majority usable) → `skipped`, commit proceeds (fail-soft, never hard-block
  on infra failure).
- **Panel size 1** (`verifierPanel: 1`) → single judge, identical to today.
- **Retry runs** → panel re-runs on the `-svretry` attempt (bounded by budget); same as the
  single-judge gate re-running today.
- **Cost** → 3× judge tokens per semantic gate. `verifierPanel` lets cost-sensitive apps set
  1; later (B2) the confidence layer can early-exit on unanimous-pass.
- **Concurrency** → 3 judges run concurrently *within* the semantic gate; the outer
  post-exit gate sequence is unchanged. Worktree-mode judges all read the same finished
  run's worktree (read-only), as the single judge does today.
- **Back-compat** → apps with `quality.verifier: false` stay off; apps that never set it now
  get the panel (default-on) — a deliberate behavior change for quality, called out in the
  changelog.

## Testing (vitest)

- `judgePanel.test.ts` — `aggregatePanel` truth table: 0/1/2/3 broken; drift precedence;
  inconclusive→skipped; concerns de-dup + cap; votes recorded.
- `apps` / `appsQuality.test.ts` — `semanticVerifierEnabled`: undefined→true (default-on),
  `false`→false, `true`→true; `verifierPanel` clamp (1–5, default 3).
- `semanticVerifier` — `runSemanticVerifier` dispatches to panel when size≥2, single when 1
  (spawn mocked / `runAgentGate` stubbed).
- `meta` — `RunSemanticVerifier.votes` round-trips (optional field, legacy rows = absent).

## Acceptance criteria

1. With default config, a semantic gate spawns **3** judge runs (distinct lenses) and blocks
   only when ≥ 2 return `broken`.
2. Each lens's verdict + reason is recorded in `Run.semanticVerifier.votes` and visible in
   the UI.
3. An inconclusive panel (majority skipped) does **not** block the commit.
4. `verifierPanel: 1` reproduces today's single-judge behavior exactly.
5. The coder report contract now requires a self-review pass before the report.
6. Existing tasks/apps behave sensibly: `quality.verifier: false` stays off; all suites +
   typecheck + lint clean.

## Out of scope (B2 / later)

- **Confidence score + human escalation** (low-confidence → Epic A `awaiting-approval`) — B2.
- Panel-izing the **style critic** (v1 panels only the semantic gate, the highest-value
  judge).
- Per-lens custom playbooks / operator-defined lenses (fixed 3 for v1).
- Effort-tier-scaled panel size (config is per-app for v1; effort-scaling is a later tune).
