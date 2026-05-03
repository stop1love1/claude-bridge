import { Link } from "react-router-dom";
import type { TaskMeta } from "@/api/types";
import StatusDot from "@/components/StatusDot";
import { relTime } from "@/lib/time";
import { cn } from "@/lib/cn";

interface Props {
  task: TaskMeta;
  index: number;
}

// Flat preview — first ~3 lines of body, but trimmed to avoid layout
// jitter from runs of blank lines.
function preview(body: string, max = 220): string {
  const cleaned = body
    .replace(/\r\n/g, "\n")
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .slice(0, 3)
    .join(" · ");
  return cleaned.length > max ? cleaned.slice(0, max - 1) + "…" : cleaned;
}

export default function TaskCard({ task, index }: Props) {
  const runs = task.runs ?? [];
  const lastRun = runs[runs.length - 1];
  const liveRuns = runs.filter((r) => r.status === "running").length;

  // Stagger reveal — 30ms per card, capped so very long lists don't
  // collect a perceptible delay tail.
  const delay = `${Math.min(index * 30, 360)}ms`;

  return (
    <Link
      to={`/tasks/${task.taskId}`}
      style={{ animationDelay: delay }}
      className={cn(
        "group block rounded-sm border border-border bg-surface p-4",
        "animate-fade-up transition-all duration-200",
        "hover:-translate-y-px hover:border-border-strong hover:bg-surface-2",
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <span className="font-mono text-micro tracking-wideish text-muted-2">
          {task.taskId}
        </span>
        <span className="font-mono text-micro tabular-nums text-muted-2">
          {relTime(task.createdAt)}
        </span>
      </div>

      <h3 className="mt-2 font-sans text-base font-medium leading-snug text-fg group-hover:text-accent">
        {task.taskTitle || (
          <span className="italic text-muted">untitled task</span>
        )}
      </h3>

      {task.taskBody && (
        <p className="mt-2 line-clamp-3 text-small text-muted">
          {preview(task.taskBody)}
        </p>
      )}

      {(runs.length > 0 || task.taskApp) && (
        <div className="mt-4 flex items-center justify-between gap-3">
          <div className="flex items-center gap-1.5">
            {runs.slice(-8).map((run) => (
              <StatusDot
                key={run.sessionId}
                status={run.status}
                size="xs"
              />
            ))}
            {runs.length > 8 && (
              <span className="font-mono text-micro text-muted-2">
                +{runs.length - 8}
              </span>
            )}
          </div>
          <div className="flex items-center gap-3 font-mono text-micro tracking-wideish text-muted-2">
            {task.taskApp && (
              <span className="truncate" title={task.taskApp}>
                {task.taskApp}
              </span>
            )}
            {liveRuns > 0 && (
              <span className="text-status-doing">
                ● {liveRuns} live
              </span>
            )}
            {!liveRuns && lastRun && (
              <span className="uppercase">{lastRun.role}</span>
            )}
          </div>
        </div>
      )}
    </Link>
  );
}
