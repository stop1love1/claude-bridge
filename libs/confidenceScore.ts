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

function bandFor(score: number): ConfidenceBand {
  if (score >= 80) return "high";
  if (score >= 60) return "medium";
  return "low";
}

/**
 * Compute a 0..100 confidence score. Starts at 100 and subtracts a penalty
 * per weak signal. Gates that didn't run (`undefined`) contribute 0 unless
 * their *absence* itself is a missing-check signal (verifier / semantic).
 */
export function computeConfidence(run: Run): ConfidenceResult {
  const b: ConfidenceBreakdown = { verify: 0, verifier: 0, style: 0, semantic: 0, panelSplit: 0 };

  // Verify chain — failure is rare here (it would have blocked), but a
  // recorded failure is the strongest negative signal.
  if (run.verify && run.verify.passed === false) b.verify -= 40;

  // Claim-vs-diff verifier (honesty check).
  const v = run.verifier;
  if (v) {
    if (v.verdict === "drift") b.verifier -= 10;
    else if (v.verdict === "broken") b.verifier -= 25;
    else if (v.verdict === "skipped") b.verifier -= 5;
    const unmatched = Array.isArray(v.unmatchedClaims) ? v.unmatchedClaims.length : 0;
    b.verifier -= Math.min(UNMATCHED_CLAIM_CAP, unmatched * UNMATCHED_CLAIM_PENALTY);
  }

  // Style critic.
  const s = run.styleCritic;
  if (s) {
    if (s.verdict === "drift") b.style -= 8;
    else if (s.verdict === "alien") b.style -= 25;
  }

  // Semantic panel (B1).
  const sv = run.semanticVerifier;
  if (sv) {
    if (sv.verdict === "drift") b.semantic -= 15;
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
}

/**
 * Whether to hold outward actions (auto-push + integration). Never holds
 * when disabled, at/above threshold, or in worktree mode (the worktree
 * commits + merges back on cleanup by design — v1 records the score but
 * doesn't hold that path).
 */
export function shouldHoldOutward(
  score: number,
  cfg: ConfidenceGateConfig,
  isWorktree: boolean,
): boolean {
  if (!cfg.enabled) return false;
  if (isWorktree) return false;
  return score < cfg.threshold;
}
