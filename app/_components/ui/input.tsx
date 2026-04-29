"use client";

import * as React from "react";
import { cn } from "@/libs/cn";

export const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  ({ className, type, ...props }, ref) => (
    <input
      ref={ref}
      type={type}
      className={cn(
        "flex h-8 w-full rounded-md border border-border bg-background px-3 py-1 text-[11px] sm:text-xs shadow-sm",
        "placeholder:text-muted-foreground/70 placeholder:text-[11px] sm:placeholder:text-xs",
        "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
        "disabled:cursor-not-allowed disabled:opacity-50",
        "file:border-0 file:bg-transparent file:text-xs file:font-medium",
        className,
      )}
      {...props}
    />
  ),
);
Input.displayName = "Input";
