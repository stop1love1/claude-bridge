import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/cn";

/**
 * Standard "no data yet" placeholder. Uses a dashed border + dim
 * surface so it reads as a hint, not an error. Pass an icon, a
 * one-line title, an optional hint paragraph, and optional CTA.
 */
export function EmptyState({
  icon: Icon,
  title,
  hint,
  action,
  className,
}: {
  icon: LucideIcon;
  title: string;
  hint?: string;
  action?: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "rounded-sm border border-dashed border-border bg-surface/50 p-8 text-center",
        className,
      )}
    >
      <Icon size={28} className="mx-auto mb-3 opacity-40" aria-hidden="true" />
      <p className="text-small font-medium text-fg mb-1">{title}</p>
      {hint && (
        <p className="text-small text-muted mb-4 max-w-sm mx-auto">{hint}</p>
      )}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}
