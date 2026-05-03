import * as React from "react";
import { cn } from "@/lib/cn";

// Monospace by default so token, branch, and path inputs share the
// editorial typography. Accent ring on focus, border-strong on hover.
export const Input = React.forwardRef<
  HTMLInputElement,
  React.InputHTMLAttributes<HTMLInputElement>
>(({ className, type, ...props }, ref) => (
  <input
    ref={ref}
    type={type}
    className={cn(
      "flex h-8 w-full rounded-md border border-border bg-bg px-3 py-1 font-mono text-xs shadow-sm",
      "placeholder:text-muted-2 placeholder:text-xs",
      "transition-colors hover:border-border-strong",
      "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
      "disabled:cursor-not-allowed disabled:opacity-50",
      "file:border-0 file:bg-transparent file:text-xs file:font-medium",
      className,
    )}
    {...props}
  />
));
Input.displayName = "Input";
