import type { RunStatus } from "@/libs/client/types";

const COLOR: Record<RunStatus, string> = {
  queued: "bg-fg-dim",
  running: "bg-warning animate-pulse",
  done: "bg-success",
  failed: "bg-destructive",
  stale: "bg-info",
};

/**
 * `orchestrating` = the coordinator's process is terminal but at least
 * one child it spawned is still active. The dot inherits the warning
 * pulse so it visually matches a literal RUNNING dot — operators
 * scanning the row read "this thing is still working" without having
 * to interpret the per-status colour. The aria-label gets the same
 * substitution so screen readers don't say "done" while the badge
 * pulses.
 */
export function StatusDot({
  status,
  orchestrating = false,
}: {
  status: RunStatus;
  orchestrating?: boolean;
}) {
  const cls = orchestrating ? "bg-warning animate-pulse" : COLOR[status];
  const label = orchestrating ? "orchestrating" : status;
  return <span className={`inline-block w-2 h-2 rounded-full ${cls}`} aria-label={label} />;
}
