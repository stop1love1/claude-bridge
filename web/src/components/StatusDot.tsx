import type { RunStatus } from "@/api/types";
import { cn } from "@/lib/cn";

const COLOR: Record<RunStatus, string> = {
  queued: "bg-run-queued",
  running: "bg-run-running animate-pulse-slow",
  done: "bg-run-done",
  failed: "bg-run-failed",
  stale: "bg-run-stale",
};

interface Props {
  status: RunStatus;
  size?: "xs" | "sm" | "md";
  label?: boolean;
  className?: string;
}

export default function StatusDot({
  status,
  size = "sm",
  label = false,
  className,
}: Props) {
  const sz =
    size === "xs" ? "h-1.5 w-1.5" : size === "sm" ? "h-2 w-2" : "h-2.5 w-2.5";
  return (
    <span
      className={cn("inline-flex items-center gap-2", className)}
      title={status}
    >
      <span
        className={cn("inline-block rounded-full shrink-0", sz, COLOR[status])}
      />
      {label && (
        <span className="font-mono text-micro uppercase tracking-wideish text-muted">
          {status}
        </span>
      )}
    </span>
  );
}
