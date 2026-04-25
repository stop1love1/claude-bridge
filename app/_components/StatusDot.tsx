import type { RunStatus } from "@/lib/client/types";

const COLOR: Record<RunStatus, string> = {
  queued: "bg-fg-dim",
  running: "bg-warning animate-pulse",
  done: "bg-success",
  failed: "bg-destructive",
  stale: "bg-info",
};

export function StatusDot({ status }: { status: RunStatus }) {
  return <span className={`inline-block w-2 h-2 rounded-full ${COLOR[status]}`} aria-label={status} />;
}
