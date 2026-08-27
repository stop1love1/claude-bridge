import { isAnyRetryRole } from "./retryLadder";
import type { Run } from "./meta";

export function nearDuplicateStems(role: string): string[] {
  const stems = new Set<string>();
  const dash = /^(.+?)-[A-Za-z0-9]+$/.exec(role);
  if (dash && dash[1].length > 0) stems.add(dash[1]);
  const digit = /^([A-Za-z][A-Za-z0-9-]*?)\d+$/.exec(role);
  if (digit && digit[1].length > 0) stems.add(digit[1]);
  return [...stems];
}

export interface NearDuplicateMatch {
  existing: Run;
  newRole: string;
  reason: string;
}

export function findNearDuplicateRole(args: {
  runs: Run[];
  parentSessionId: string | null | undefined;
  repo: string;
  role: string;
}): NearDuplicateMatch | null {
  const { runs, parentSessionId, repo, role } = args;
  if (isAnyRetryRole(role)) return null;

  const stems = nearDuplicateStems(role);
  if (stems.length === 0) return null;

  const candidates = runs
    .filter((r) => (r.parentSessionId ?? null) === (parentSessionId ?? null))
    .filter((r) => r.repo === repo)
    .filter((r) => r.status === "done" || r.status === "failed")
    .filter((r) => !isAnyRetryRole(r.role))
    .filter((r) => r.role !== role)
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
