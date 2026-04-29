/**
 * @deprecated since the detect layer landed. Kept as a thin shim around
 * `libs/detect/heuristic.ts` so existing test files keep working without
 * being rewritten. New callers MUST use `lib/detect.detectScope` /
 * `lib/detect.heuristicDetector` directly — those are the standardized
 * surface that handles bilingual matching, declared capabilities, LLM
 * fallback, and scope caching.
 *
 * This file forwards `suggestRepo` (the original "pick one repo from a
 * task body" helper) and `classifyRepoRoles` (used by the new heuristic
 * internally).
 */

import {
  classifyRepoRoles,
  detectScopeSync,
  heuristicDetector,
} from "./detect/heuristic";
import type { RepoProfile } from "./repoProfile";

export interface RepoSuggestion {
  repo: string | null;
  reason: string;
  score: number;
}

/**
 * @deprecated Use `lib/detect.detectScope` (or `heuristicDetector.detect`
 * directly) instead. This shim flattens the new `DetectedScope` shape
 * back to the legacy `{ repo, reason, score }` so old call sites and
 * tests keep working.
 */
export async function suggestRepoAsync(
  promptText: string,
  repos: string[],
  profiles?: Record<string, RepoProfile>,
): Promise<RepoSuggestion> {
  const scope = await heuristicDetector.detect({
    taskBody: promptText,
    repos,
    profiles,
  });
  const top = scope.repos[0];
  if (!top || top.score === 0) {
    return { repo: null, reason: scope.reason || "no clear match", score: 0 };
  }
  // Detect the legacy "tie" case: same score for top + runner-up.
  const runner = scope.repos[1];
  if (runner && runner.score === top.score) {
    return {
      repo: null,
      reason: `tie between ${top.name} and ${runner.name}`,
      score: top.score,
    };
  }
  return { repo: top.name, reason: top.reason, score: top.score };
}

/**
 * @deprecated Use `lib/detect.detectScope` instead. Sync wrapper that
 * delegates to `detectScopeSync` and flattens the result back to the
 * legacy `{ repo, reason, score }` contract.
 */
export function suggestRepo(
  promptText: string,
  repos: string[],
  profiles?: Record<string, RepoProfile>,
): RepoSuggestion {
  const scope = detectScopeSync({ taskBody: promptText, repos, profiles });
  const top = scope.repos[0];
  if (!top || top.score === 0) {
    // Strip the "heuristic:" prefix the new module adds so the legacy
    // contract (`reason: "no clear match"`) keeps working for callers
    // that match on the literal string.
    const reason = scope.reason.replace(/^heuristic:\s*/, "") || "no clear match";
    return { repo: null, reason, score: 0 };
  }
  const runner = scope.repos[1];
  if (runner && runner.score === top.score) {
    return {
      repo: null,
      reason: `tie between ${top.name} and ${runner.name}`,
      score: top.score,
    };
  }
  return { repo: top.name, reason: top.reason, score: top.score };
}

// Quiet the "imported but unused" warning when callers only use the
// async variant — keeps the import attached so tree-shaking doesn't
// drop the new heuristic when this module is the entry point.
void heuristicDetector;

export { classifyRepoRoles };
