/**
 * Detect "near-duplicate" role spawns the coordinator likely meant to
 * `mode:"resume"` instead of `mode:"spawn"`.
 *
 * Why: in prod we caught a coordinator that finished a `fixer @ X` run,
 * then for an adjacent fix in the same repo dispatched `fixer-cashier @ X`
 * as a fresh spawn. The new agent re-paid for context the original
 * `fixer` already had — pure waste. The bridge's spawn path can't auto-
 * redirect (the coordinator might genuinely mean a different area), but
 * it CAN warn so the LLM sees a hint on the next turn and the operator
 * sees a flag in the response payload / logs.
 *
 * Heuristic: we strip ONE suffix off the new role at a time and check
 * whether the resulting stem matches an existing TERMINAL run on the
 * same `(parentSessionId, repo)`. Two strip strategies:
 *   - trailing `-<token>`     → `fixer-cashier` → `fixer`,
 *                                `coder-v2`     → `coder-v`
 *   - trailing digits         → `fixer2`        → `fixer`,
 *                                `coder-v2`     → `coder-v`
 *
 * Sanctioned retries (`*-retry`, `*-vretry`, `*-cretry`, `*-stretry`,
 * `*-svretry`, with optional numeric suffix) are skipped on BOTH ends —
 * the new role being a retry, OR an existing run being a retry, both
 * disqualify the match. Retries are bridge-managed and never represent
 * "the coordinator should have resumed."
 */
import { isAnyRetryRole } from "./retryLadder";
import type { Run } from "./meta";

/**
 * Possible parent roles by stripping exactly one suffix. Returns at
 * most two candidates (dash-token strip + digit strip), de-duplicated.
 */
export function nearDuplicateStems(role: string): string[] {
  const stems = new Set<string>();
  // Strip a trailing `-<token>` where token is one or more alphanumeric
  // chars. `fixer-cashier` → `fixer`.
  const dash = /^(.+?)-[A-Za-z0-9]+$/.exec(role);
  if (dash && dash[1].length > 0) stems.add(dash[1]);
  // Strip trailing digits. `fixer2` → `fixer`. The leading char must be
  // alpha so we don't try to "strip" a role that's all digits.
  const digit = /^([A-Za-z][A-Za-z0-9-]*?)\d+$/.exec(role);
  if (digit && digit[1].length > 0) stems.add(digit[1]);
  return [...stems];
}

export interface NearDuplicateMatch {
  /** The existing terminal run the coordinator likely should have resumed. */
  existing: Run;
  /** The new role that triggered the warning. */
  newRole: string;
  /** Human-readable reason ("`fixer-cashier` is a suffix variant of `fixer`"). */
  reason: string;
}

/**
 * Scan `runs` for a terminal sibling whose role would have been the
 * sensible resume target for `role`. Returns `null` when no match (the
 * common case — first-time roles, genuinely distinct work, etc.).
 *
 * `repo` and `parentSessionId` MUST match — a near-duplicate role on a
 * different repo or under a different coordinator is a different agent
 * and resume wouldn't apply.
 */
export function findNearDuplicateRole(args: {
  runs: Run[];
  parentSessionId: string | null | undefined;
  repo: string;
  role: string;
}): NearDuplicateMatch | null {
  const { runs, parentSessionId, repo, role } = args;
  // The new role itself being a retry means the bridge auto-spawned it
  // — coordinator never POSTed it directly, so warning is moot.
  if (isAnyRetryRole(role)) return null;

  const stems = nearDuplicateStems(role);
  if (stems.length === 0) return null;

  // Earliest-completed match wins so the warning consistently points at
  // the original child rather than a follow-up the coordinator already
  // (correctly) resumed.
  const candidates = runs
    .filter((r) => (r.parentSessionId ?? null) === (parentSessionId ?? null))
    .filter((r) => r.repo === repo)
    .filter((r) => r.status === "done" || r.status === "failed")
    .filter((r) => !isAnyRetryRole(r.role))
    .filter((r) => r.role !== role) // exact-equal handled by the regular dedup path
    .filter((r) => stems.includes(r.role))
    .sort((a, b) => (a.endedAt ?? "").localeCompare(b.endedAt ?? ""));

  const existing = candidates[0];
  if (!existing) return null;

  return {
    existing,
    newRole: role,
    reason: `\`${role}\` is a suffix/digit variant of the already-finished role \`${existing.role}\` — the coordinator likely should have used \`mode:"resume"\` against the existing session (priorSessionId=${existing.sessionId}) instead of spawning a fresh agent. See coordinator-playbook.md §2 'Reusing an existing child'.`,
  };
}
