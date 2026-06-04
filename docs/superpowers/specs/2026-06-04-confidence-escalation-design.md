# Confidence Score + Human Escalation (Epic B2) — Design

- **Date:** 2026-06-04
- **Status:** Approved direction (operator: "toàn bộ"); details delegated to Claude.
- **Epic:** B2 (closes Epic B). Builds on B1's gate results.
- **Owner repo:** `claude-bridge`.

## Problem

After the post-exit gates pass, the bridge auto-commits / pushes / integrates with no
aggregate notion of *how confident* it is. A run can technically pass every gate yet still be
borderline (split semantic panel, claim-vs-diff drift, style drift). Outward, hard-to-reverse
actions (push, merge-to-target, PR) shouldn't happen unattended on borderline work.

## Goal

Aggregate the gate results into a single **confidence score (0–100)**, store it on the run,
surface it in the UI, and — when confidence is below a threshold — **hold the outward action**
(auto-push / integration) and escalate to the operator, who approves the ship (one click,
reusing the existing manual-commit endpoint) or sends a fix. Local auto-commit still happens
(it's reversible and worktree mode needs it for safety).

## Scoring (`libs/confidenceScore.ts`, pure)

`computeConfidence(run)` → `{ score: 0..100, band: "high"|"medium"|"low", breakdown: {...} }`.
Start at 100; subtract per-signal penalties (weights tuned, documented in code):

| Signal (`Run` field) | Penalty |
|---|---|
| `verify.passed === false` | −40 (rare here — failed verify already blocked) |
| `verifier.verdict` drift / broken | −10 / −25; plus −4 per `unmatchedClaims` (cap −12) |
| `verifier` skipped | −5 (no honesty check ran) |
| `styleCritic.verdict` drift / alien | −8 / −25 |
| `semanticVerifier.verdict` drift / broken | −15 / −40 |
| `semanticVerifier` panel split (votes present, not unanimous) | −10 |
| `semanticVerifier` skipped | −8 |

Clamp to `[0, 100]`. Bands: `high ≥ 80`, `medium 60–79`, `low < 60`. The escalation
*threshold* is configurable (default 70) and independent of the bands (bands are display).

## Config (`libs/confidenceConfig.ts`)

`.bridge-state/confidence.json` → `{ enabled: boolean (default true), threshold: number (default 70, clamped 0..100) }`. Same globalThis + atomic-write store pattern as `planGateConfig`. Operator toggle in Settings.

## Hold + escalation

`Run.confidence` (new meta field): `{ score, band, breakdown, heldAt?: string, reviewedBy?: {...} }`.

In `postExitFlow`, after all gates pass (no retry scheduled) and the confidence is computed:

- **score ≥ threshold (or disabled)** → unchanged: auto-commit + autoPush + integration per app settings.
- **score < threshold** → **hold the outward action**:
  - Local auto-commit still runs (worktree safety / reversible). The integration block
    (`auto-merge` / `pull-request`) and `autoPush` are **skipped** this pass.
  - Stamp `run.confidence.heldAt`. Surface a "Low-confidence — review before shipping" card.
  - Operator actions (UI): **Approve & ship** → calls the existing
    `POST /api/tasks/:id/runs/:sid/commit` endpoint (which commits + pushes per its body) to
    perform the held push; **Request fix** → posts a follow-up prompt (existing
    `sendMessage` / agents path). On approve, clear the hold (`reviewedBy`).
  - Worktree mode: the worktree still commits + merges back on cleanup (data safety); the
    confidence is recorded + surfaced but the merge is **not** held in v1 (documented
    limitation — worktree integration is intrinsic to cleanup).

## Components

**New:** `libs/confidenceScore.ts` (pure), `libs/confidenceConfig.ts` (store),
`app/api/settings/confidence/route.ts` (GET/PUT), `app/_components/ConfidenceBadge.tsx`
(score chip + low-confidence review note).

**Modified:** `libs/meta.ts` (`Run.confidence`), `libs/runLifecycle.ts` (compute + hold),
`libs/client/types.ts` (`Run.confidence` mirror), `app/_components/AgentTree.tsx` (badge),
`app/settings/page.tsx` (threshold), `libs/client/api.ts` (settings methods).

## Testing (vitest)

- `confidenceScore.test.ts` — scoring truth table: all-pass → 100/high; split panel → −10;
  drift verifier + style → graded; broken semantic → low; skipped gates → penalised; clamps.
- `confidenceConfig.test.ts` — defaults (on / 70), clamp threshold 0..100, persistence.
- `meta` — `Run.confidence` round-trips.
- Hold logic is exercised by a `shouldHoldOutward(score, cfg, isWorktree)` pure helper
  (unit-tested) that `runLifecycle` calls — keeps the lifecycle change thin + testable.

## Acceptance criteria

1. Every judged run gets a `confidence.score` + band, visible in the agent tree.
2. With default config, a run scoring < 70 holds auto-push + integration (non-worktree) and
   shows a review card; ≥ 70 ships as before.
3. "Approve & ship" performs the held push via the existing commit endpoint.
4. `enabled:false` reproduces today's behavior (score still recorded, never holds).
5. All suites + typecheck + lint clean.

## Out of scope

- Holding worktree-mode integration (commits/merges proceed; score recorded only).
- Tying the hold into Epic A's `awaiting-approval` (kept a distinct post-code surface).
- LLM-based confidence (pure deterministic scoring from gate results only).
