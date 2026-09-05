
export const RUN_STATUSES = [
  "queued",
  "running",
  "done",
  "failed",
  "cancelled",
  "stale",
] as const;

export type RunStatus = (typeof RUN_STATUSES)[number];

export function isValidRunStatus(s: unknown): s is RunStatus {
  return (
    typeof s === "string" && (RUN_STATUSES as readonly string[]).includes(s)
  );
}

const TERMINAL: readonly RunStatus[] = ["done", "failed", "cancelled", "stale"];

/** A run that will never flip back to `running` on its own (lifecycle hook already closed it). */
export function isTerminal(s: RunStatus): boolean {
  return TERMINAL.includes(s);
}

export function isBackwardStatusTransition(from: RunStatus, to: RunStatus): boolean {
  return TERMINAL.includes(from) && (to === "running" || to === "queued");
}
