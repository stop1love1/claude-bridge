import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/cn";

// Editorial button: coral-on-bone for the default, quiet ghost for
// secondary actions, danger for destructive confirms. Sizes top out
// at lg; `iconSm` is the canonical compact icon hit-target used by
// the header chrome.
const buttonVariants = cva(
  "inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-md text-xs font-medium transition-colors cursor-pointer focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default:    "bg-primary text-primary-foreground shadow hover:bg-primary/90",
        outline:    "border border-border bg-transparent hover:bg-card hover:text-foreground",
        ghost:      "text-fg-dim hover:bg-card hover:text-foreground",
        secondary:  "bg-secondary text-foreground hover:bg-secondary",
        link:       "text-primary underline-offset-4 hover:underline",
        danger:     "bg-destructive text-destructive-foreground hover:bg-destructive/90",
      },
      size: {
        default: "h-9 px-4 py-2",
        lg:      "h-10 px-6",
        sm:      "h-8 px-3",
        xs:      "h-7 px-2.5",
        icon:    "h-8 w-8",
        iconSm:  "h-7 w-7",
      },
    },
    defaultVariants: { variant: "default", size: "sm" },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild, ...props }, ref) => {
    const Comp = asChild ? Slot : "button";
    return (
      <Comp ref={ref} className={cn(buttonVariants({ variant, size, className }))} {...props} />
    );
  },
);
Button.displayName = "Button";

export { buttonVariants };
