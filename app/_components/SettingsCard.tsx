"use client";

import { useId, useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { cn } from "@/libs/cn";

/**
 * One setting, collapsed to a single scannable row.
 *
 * The row carries the current value, so the whole configuration can be read
 * without opening anything; the controls and the long explanation only appear
 * once the operator is actually changing that setting.
 */
export function SettingsCard({
  title,
  icon,
  summary,
  changed = false,
  defaultOpen = false,
  children,
}: {
  title: string;
  icon: React.ReactNode;
  /** Current value in a few words — shown on the collapsed row. */
  summary: React.ReactNode;
  /** Marks a setting the operator has moved off its default. */
  changed?: boolean;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const bodyId = useId();

  return (
    <section
      className={cn(
        "rounded-lg border bg-card transition-colors",
        open ? "border-border" : "border-border/70 hover:border-border",
      )}
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls={bodyId}
        className="w-full flex items-center gap-2.5 px-3 py-2.5 text-left"
      >
        {open ? (
          <ChevronDown size={13} className="shrink-0 text-muted-foreground" />
        ) : (
          <ChevronRight size={13} className="shrink-0 text-muted-foreground" />
        )}
        <span className="shrink-0 flex items-center text-primary">{icon}</span>
        <span className="text-[13px] font-medium text-foreground shrink-0">{title}</span>
        {changed && (
          <span
            className="h-1.5 w-1.5 rounded-full bg-primary shrink-0"
            title="Changed from the default"
            aria-label="Changed from the default"
          />
        )}
        <span className="flex-1" />
        {!open && (
          <span className="text-[11.5px] text-muted-foreground truncate max-w-[55%] text-right">
            {summary}
          </span>
        )}
      </button>
      {open && (
        <div id={bodyId} className="px-3 pb-3 pt-0 border-t border-border/60 mt-0">
          <div className="pt-3">{children}</div>
        </div>
      )}
    </section>
  );
}

/** Heading above a run of related settings. */
export function SettingsGroup({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-2">
      <div className="flex items-baseline gap-2 px-0.5">
        <h3 className="text-[11px] uppercase tracking-wider font-medium text-muted-foreground">
          {title}
        </h3>
        {hint && <span className="text-[11px] text-fg-dim">{hint}</span>}
      </div>
      <div className="space-y-2">{children}</div>
    </div>
  );
}
