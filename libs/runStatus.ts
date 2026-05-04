/**
 * Single source of truth for run lifecycle status.
 *
 * Lives in its own file (not `validate.ts`, not `meta.ts`, not
 * `client/types.ts`) so both server modules AND the client bundle can
 * import it without dragging in `next/server` (validate.ts) or the
 * server-only meta-write machinery (meta.ts). Keep this file dep-free.
 */

export const RUN_STATUSES = [
  "queued",
  "running",
  "done",
  "failed",
  "stale",
] as const;

export type RunStatus = (typeof RUN_STATUSES)[number];

export function isValidRunStatus(s: unknown): s is RunStatus {
  return (
    typeof s === "string" && (RUN_STATUSES as readonly string[]).includes(s)
  );
}
