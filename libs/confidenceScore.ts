/**
 * Reliability Amplifier (B2) — deterministic confidence score for a
 * finished run, aggregated from the post-exit gate results already on the
 * `Run` (verify chain, claim-vs-diff verifier, style critic, semantic
 * panel). Pure: no I/O. The lifecycle stores the result on `run.confidence`
 * and `shouldHoldOutward` decides whether to hold push/integration.
 * See docs/superpowers/specs/2026-06-04-confidence-escalation-design.md.
 */
import type { Run } from "./meta";

export type ConfidenceBand = "high" | "medium" | "low";

export interface ConfidenceBreakdown {
  verify: number;
  verifier: number;
  style: number;
  semantic: number;
  panelSplit: number;
}

export interface ConfidenceResult {
  score: number;
  band: ConfidenceBand;
  breakdown: ConfidenceBreakdown;
}

const UNMATCHED_CLAIM_PENALTY = 4;
const UNMATCHED_CLAIM_CAP = 12;

/** A gate that threw produced NO judgement at all — strictly worse than
 *  an explicit `"skipped"`, which is a recorded decision. Two crashed
 *  gates must drop the run out of the `high` band so it is held for
 *  review; one alone should not (audit C2/C3). See the crash branches
 *  in libs/runLifecycle.ts, which write this verdict. */
const CRASHED_VERIFIER_PENALTY = 15;
const CRASHED_SEMANTIC_PENALTY = 20;
const CRASHED_STYLE_PENALTY = 10;

function bandFor(score: number): ConfidenceBand {
  if (score >= 80) return "high";
  if (score >= 60) return "medium";
  return "low";
}

/**
 * Compute a 0..100 confidence score. Starts at 100 and subtracts a penalty
 * per weak signal. Gates that didn't run (`undefined`) contribute 0 — that
 * covers legitimate opt-outs (e.g. semantic verification disabled for an
 * app) where absence carries no signal. A gate that *ran and threw* is
 * distinct: Task 1 records that as an explicit `"crashed"` verdict, which
 * this function penalizes below, ahead of the milder verdicts.
 */
export function computeConfidence(run: Run): ConfidenceResult {
  const b: ConfidenceBreakdown = { verify: 0, verifier: 0, style: 0, semantic: 0, panelSplit: 0 };

  // Verify chain — failure is rare here (it would have blocked), but a
  // recorded failure is the strongest negative signal.
  if (run.verify && run.verify.passed === false) b.verify -= 40;

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

  // Style critic.
  const s = run.styleCritic;
  if (s) {
    if (s.verdict === "crashed") b.style -= CRASHED_STYLE_PENALTY;
    else if (s.verdict === "drift") b.style -= 8;
    else if (s.verdict === "alien") b.style -= 25;
  }

  // Semantic panel (B1).
  const sv = run.semanticVerifier;
  if (sv) {
    if (sv.verdict === "crashed") b.semantic -= CRASHED_SEMANTIC_PENALTY;
    else if (sv.verdict === "drift") b.semantic -= 15;
    else if (sv.verdict === "broken") b.semantic -= 40;
    else if (sv.verdict === "skipped") b.semantic -= 8;
    // Split panel: votes present but not unanimous → lower confidence even
    // when the majority verdict is pass.
    if (Array.isArray(sv.votes) && sv.votes.length > 1) {
      const verdicts = new Set(sv.votes.map((x) => x.verdict));
      if (verdicts.size > 1) b.panelSplit -= 10;
    }
  }

  const raw = 100 + b.verify + b.verifier + b.style + b.semantic + b.panelSplit;
  const score = Math.max(0, Math.min(100, raw));
  return { score, band: bandFor(score), breakdown: b };
}

export interface ConfidenceGateConfig {
  enabled: boolean;
  threshold: number;
  /**
   * Opt-in (Task 7). When absent/false, worktree runs are NEVER held
   * (v1 behavior, unchanged): the worktree commits + merges back on
   * cleanup regardless of score. When `true`, a worktree run below
   * `threshold` holds exactly like a live-tree run — the merge-back +
   * integration are deferred until an operator ships/dismisses via the
   * confidence review route, and the worktree is kept alive for review.
   */
  holdWorktree?: boolean;
}

/**
 * Whether to hold outward actions (auto-push + integration). Never holds
 * when disabled or at/above threshold. Worktree runs only hold when the
 * operator opted in via `cfg.holdWorktree` — the default is to never hold
 * worktree runs (they commit + merge back on cleanup by design).
 */
export function shouldHoldOutward(
  score: number,
  cfg: ConfidenceGateConfig,
  isWorktree: boolean,
): boolean {
  if (!cfg.enabled) return false;
  if (isWorktree && !cfg.holdWorktree) return false;
  return score < cfg.threshold;
}
