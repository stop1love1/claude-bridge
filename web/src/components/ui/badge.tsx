import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/cn";

// Editorial pill — micro caps. Status variants line up with our task
// sections so column counters / row badges stay color-coded. The
// `accent` and `status-*` variants are SPA-specific carryovers kept
// for back-compat with existing call sites.
const badgeVariants = cva(
  "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide",
  {
    variants: {
      variant: {
        default:     "border-transparent bg-primary text-primary-foreground",
        secondary:   "border-transparent bg-secondary text-secondary-foreground",
        destructive: "border-transparent bg-destructive text-destructive-foreground",
        outline:     "text-foreground",
        success:     "border-success/30 bg-success/15 text-success",
        warning:     "border-warning/30 bg-warning/15 text-warning",
        info:        "border-info/30 bg-info/15 text-info",
        muted:       "border-border bg-muted text-muted-foreground",
        // SPA back-compat variants (do not remove without updating callers).
        accent:           "border-primary/30 bg-primary/15 text-primary",
        "status-todo":    "border-status-todo/30 bg-status-todo/15 text-status-todo",
        "status-doing":   "border-status-doing/30 bg-status-doing/15 text-status-doing",
        "status-blocked": "border-status-blocked/30 bg-status-blocked/15 text-status-blocked",
        "status-done":    "border-status-done/30 bg-status-done/15 text-status-done",
      },
    },
    defaultVariants: { variant: "default" },
  },
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {}

export function Badge({ className, variant, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />;
}

export { badgeVariants };
