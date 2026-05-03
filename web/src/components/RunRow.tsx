import { useState } from "react";
import { ChevronRight } from "lucide-react";
import type { Run } from "@/api/types";
import StatusDot from "@/components/StatusDot";
import { durationMs, relTime } from "@/lib/time";
import { cn } from "@/lib/cn";

interface Props {
  run: Run;
}

export default function RunRow({ run }: Props) {
  const [open, setOpen] = useState(false);
  const dur = durationMs(run.startedAt, run.endedAt);

  return (
    <li className="border-b border-border last:border-b-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={cn(
          "grid w-full grid-cols-[16px_minmax(0,1fr)_auto_auto_auto_auto] items-center gap-4 px-2 py-3 text-left",
          "hover:bg-secondary",
        )}
      >
        <ChevronRight
          size={12}
          className={cn(
            "text-fg-dim transition-transform",
            open && "rotate-90 text-foreground",
          )}
        />
        <div className="flex min-w-0 items-center gap-3">
          <StatusDot status={run.status} size="sm" />
          <span className="font-mono text-micro uppercase tracking-wideish text-foreground">
            {run.role}
          </span>
          <span className="truncate font-mono text-micro text-fg-dim">
            {run.repo || "—"}
          </span>
        </div>
        <span className="font-mono text-micro uppercase tracking-wideish text-muted-foreground">
          {run.status}
        </span>
        <span className="font-mono text-micro tabular-nums text-fg-dim">
          {dur}
        </span>
        <span className="font-mono text-micro tabular-nums text-fg-dim">
          {relTime(run.startedAt)}
        </span>
        <span className="font-mono text-micro text-fg-dim truncate max-w-[180px]">
          {run.sessionId.slice(0, 8)}
        </span>
      </button>

      {open && (
        <div className="grid grid-cols-[120px_minmax(0,1fr)] gap-x-6 gap-y-1 border-t border-border bg-secondary px-6 py-4 text-small">
          <span className="font-mono text-micro uppercase tracking-wideish text-muted-foreground">
            session
          </span>
          <span className="font-mono text-small break-all text-foreground">
            {run.sessionId}
          </span>
          {run.parentSessionId && (
            <>
              <span className="font-mono text-micro uppercase tracking-wideish text-muted-foreground">
                parent
              </span>
              <span className="font-mono text-small break-all text-muted-foreground">
                {run.parentSessionId}
              </span>
            </>
          )}
          {run.worktreeBranch && (
            <>
              <span className="font-mono text-micro uppercase tracking-wideish text-muted-foreground">
                branch
              </span>
              <span className="font-mono text-small text-muted-foreground">
                {run.worktreeBranch}
              </span>
            </>
          )}
          <span className="font-mono text-micro uppercase tracking-wideish text-muted-foreground">
            started
          </span>
          <span className="font-mono text-small tabular-nums text-muted-foreground">
            {run.startedAt ?? "—"}
          </span>
          <span className="font-mono text-micro uppercase tracking-wideish text-muted-foreground">
            ended
          </span>
          <span className="font-mono text-small tabular-nums text-muted-foreground">
            {run.endedAt ?? "—"}
          </span>
          {typeof run.exitCode === "number" && (
            <>
              <span className="font-mono text-micro uppercase tracking-wideish text-muted-foreground">
                exit
              </span>
              <span className="font-mono text-small tabular-nums text-muted-foreground">
                {run.exitCode}
              </span>
            </>
          )}
        </div>
      )}
    </li>
  );
}
