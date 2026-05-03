import { cn } from "@/lib/cn";

/**
 * Animated placeholder while a panel loads. Uses the surface color
 * (not muted-text gray) so the skeleton reads as a recessed shape,
 * not text.
 */
export function Skeleton({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      aria-hidden="true"
      className={cn("animate-pulse-slow rounded-md bg-secondary", className)}
      {...props}
    />
  );
}

/**
 * Stacked-card skeleton for list views (tasks, sessions, apps).
 */
export function ListSkeleton({
  rows = 3,
  className,
}: {
  rows?: number;
  className?: string;
}) {
  return (
    <div className={cn("space-y-2", className)}>
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="rounded-sm border border-border p-3 bg-card">
          <div className="flex items-start gap-3">
            <Skeleton className="h-4 w-4 rounded-sm shrink-0 mt-0.5" />
            <div className="flex-1 space-y-2">
              <Skeleton className="h-3 w-2/3" />
              <Skeleton className="h-2.5 w-1/3" />
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
