import type { LucideIcon } from "lucide-react";
import { cn } from "@/libs/cn";

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
    <div className={cn("rounded-lg border border-dashed border-border bg-card p-8 text-center", className)}>
      <Icon size={28} className="mx-auto mb-3 opacity-40" aria-hidden="true" />
      <p className="text-sm font-medium mb-1">{title}</p>
      {hint && (
        <p className="text-xs text-muted-foreground mb-4 max-w-sm mx-auto">{hint}</p>
      )}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}
