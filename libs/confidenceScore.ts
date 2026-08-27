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

const CRASHED_VERIFIER_PENALTY = 15;
const CRASHED_SEMANTIC_PENALTY = 20;
const CRASHED_STYLE_PENALTY = 10;

function bandFor(score: number): ConfidenceBand {
  if (score >= 80) return "high";
  if (score >= 60) return "medium";
  return "low";
}

export function computeConfidence(run: Run): ConfidenceResult {
  const b: ConfidenceBreakdown = { verify: 0, verifier: 0, style: 0, semantic: 0, panelSplit: 0 };

  if (run.verify && run.verify.passed === false) b.verify -= 40;

  const v = run.verifier;
  if (v) {
    if (v.verdict === "crashed") b.verifier -= CRASHED_VERIFIER_PENALTY;
    else if (v.verdict === "drift") b.verifier -= 10;
    else if (v.verdict === "broken") b.verifier -= 25;
    else if (v.verdict === "skipped") b.verifier -= 5;
    const unmatched = Array.isArray(v.unmatchedClaims) ? v.unmatchedClaims.length : 0;
    b.verifier -= Math.min(UNMATCHED_CLAIM_CAP, unmatched * UNMATCHED_CLAIM_PENALTY);
  }

  const s = run.styleCritic;
  if (s) {
    if (s.verdict === "crashed") b.style -= CRASHED_STYLE_PENALTY;
    else if (s.verdict === "drift") b.style -= 8;
    else if (s.verdict === "alien") b.style -= 25;
  }

  const sv = run.semanticVerifier;
  if (sv) {
    if (sv.verdict === "crashed") b.semantic -= CRASHED_SEMANTIC_PENALTY;
    else if (sv.verdict === "drift") b.semantic -= 15;
    else if (sv.verdict === "broken") b.semantic -= 40;
    else if (sv.verdict === "skipped") b.semantic -= 8;
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
  holdWorktree?: boolean;
}

export function shouldHoldOutward(
  score: number,
  cfg: ConfidenceGateConfig,
  isWorktree: boolean,
): boolean {
  if (!cfg.enabled) return false;
  if (isWorktree && !cfg.holdWorktree) return false;
  return score < cfg.threshold;
}
