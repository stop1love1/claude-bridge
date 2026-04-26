import { cn } from "@/lib/cn";

/**
 * Animated skeleton placeholder. Use in place of "Loading…" text while
 * a list / card / detail panel is fetching, so the layout doesn't pop
 * when data lands.
 */
export function Skeleton({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      aria-hidden="true"
      className={cn(
        "animate-pulse rounded-md bg-muted/60",
        className,
      )}
      {...props}
    />
  );
}

/**
 * Three vertically-stacked card skeletons, sized like a typical task /
 * app / session list row. Drop-in replacement for "Loading…" lists.
 */
export function ListSkeleton({ rows = 3, className }: { rows?: number; className?: string }) {
  return (
    <div className={cn("space-y-2", className)}>
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="rounded-lg border border-border p-3 bg-card">
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
