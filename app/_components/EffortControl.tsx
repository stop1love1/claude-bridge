"use client";

import { Sparkles } from "lucide-react";
import type { EffortLevel } from "@/libs/client/types";
import { cn } from "@/libs/cn";

const DOT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;
type DotLevel = (typeof DOT_LEVELS)[number];

export const EFFORT_LABEL: Record<EffortLevel, string> = {
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "xhigh",
  max: "max",
  ultracode: "Ultracode · xhigh + bridge fan-out",
};

export function EffortControl({
  value,
  onChange,
}: {
  value?: EffortLevel;
  onChange: (next: EffortLevel) => void;
}) {
  const current: EffortLevel = value ?? "max";
  const isUltra = current === "ultracode";
  const dotIdx = isUltra ? DOT_LEVELS.length - 1 : DOT_LEVELS.indexOf(current as DotLevel);

  return (
    <div className="flex items-center gap-3 w-full">
      <div className="flex items-center gap-1.5 text-[12.5px] font-medium text-foreground">
        <span className="inline-flex items-center justify-center h-4 w-4 rounded-sm border border-border text-muted-foreground">
          <svg viewBox="0 0 16 16" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="1.5">
            <path d="M3 6h10M3 10h10" strokeLinecap="round" />
            <circle cx="6" cy="6" r="1.5" fill="currentColor" />
            <circle cx="10" cy="10" r="1.5" fill="currentColor" />
          </svg>
        </span>
        Effort
        <span className="text-muted-foreground font-normal">({EFFORT_LABEL[current]})</span>
      </div>

      <div className="ml-auto inline-flex items-center gap-2">
        <div className="inline-flex items-center gap-1.5 px-2 py-1 rounded-full bg-secondary/60 border border-border">
          {DOT_LEVELS.map((lvl, i) => {
            const filled = isUltra || i <= dotIdx;
            return (
              <button
                key={lvl}
                type="button"
                onClick={() => onChange(lvl)}
                title={lvl}
                aria-label={`Effort: ${lvl}`}
                aria-pressed={!isUltra && current === lvl}
                className={cn(
                  "h-2 w-2 rounded-full transition-colors",
                  filled ? "bg-foreground" : "bg-muted-foreground/25 hover:bg-muted-foreground/50",
                )}
              />
            );
          })}
        </div>
        <button
          type="button"
          onClick={() => onChange("ultracode")}
          title="Ultracode — xhigh effort + the bridge fan-out directive (the IDE Workflow tool can't run in headless agents)"
          aria-label="Effort: Ultracode"
          aria-pressed={isUltra}
          className={cn(
            "inline-flex items-center gap-1 px-2 py-1 rounded-full border text-[10.5px] font-medium transition-colors",
            isUltra
              ? "border-primary bg-primary/15 text-primary"
              : "border-border bg-secondary/60 text-muted-foreground hover:text-foreground hover:border-primary/60",
          )}
        >
          <Sparkles className="h-3 w-3" />
          Ultra
        </button>
      </div>
    </div>
  );
}
