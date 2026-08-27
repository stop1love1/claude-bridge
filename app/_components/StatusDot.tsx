import type { RunStatus } from "@/libs/client/types";

const COLOR: Record<RunStatus, string> = {
  queued: "bg-fg-dim",
  running: "bg-warning animate-pulse",
  done: "bg-success",
  failed: "bg-destructive",
  cancelled: "bg-fg-dim",
  stale: "bg-info",
};

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
