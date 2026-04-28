"use client";

import { useState } from "react";
import { Hand, Code2, ListTree, Zap, Check } from "lucide-react";
import * as PopoverPrimitive from "@radix-ui/react-popover";
import type { ChatSettings, PermissionMode, EffortLevel } from "@/lib/client/types";
import { Button } from "./ui/button";
import { cn } from "@/lib/cn";

const MODE_OPTIONS: Array<{
  value: PermissionMode;
  label: string;
  hint: string;
  icon: React.ComponentType<{ size?: number; className?: string }>;
}> = [
  {
    value: "default",
    label: "Ask before edits",
    hint: "Claude will ask for approval before making each edit",
    icon: Hand,
  },
  {
    value: "acceptEdits",
    label: "Edit automatically",
    hint: "Claude will edit your selected text or the whole file",
    icon: Code2,
  },
  {
    value: "plan",
    label: "Plan mode",
    hint: "Claude will explore the code and present a plan before editing",
    icon: ListTree,
  },
  {
    value: "auto",
    label: "Auto mode",
    hint: "Claude will automatically choose the best permission mode for each task",
    icon: Zap,
  },
];

const EFFORT_LEVELS: EffortLevel[] = ["low", "medium", "high", "max"];

/**
 * Mode + effort picker — Claude-style. Anchors to the mode-pill
 * Trigger and pops upward, right-aligned with the trigger so the
 * panel extends leftward over the chat instead of clipping the
 * viewport edge.
 */
export function ChatSettingsMenu({
  value,
  onChange,
}: {
  value: ChatSettings;
  onChange: (next: ChatSettings) => void;
}) {
  const [open, setOpen] = useState(false);
  const currentMode = value.mode ?? "default";
  const currentMeta = MODE_OPTIONS.find((m) => m.value === currentMode) ?? MODE_OPTIONS[0];
  const ModeIcon = currentMeta.icon;
  const effortIdx = value.effort ? EFFORT_LEVELS.indexOf(value.effort) : EFFORT_LEVELS.length - 1;
  const effortLabel = value.effort ?? "max";

  return (
    <PopoverPrimitive.Root open={open} onOpenChange={setOpen}>
      <PopoverPrimitive.Trigger asChild>
        <Button variant="ghost" size="xs" title={currentMeta.label} className="gap-1.5">
          <ModeIcon className="h-3 w-3 text-primary" />
          <span className="font-medium">{currentMeta.label}</span>
        </Button>
      </PopoverPrimitive.Trigger>
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content
          align="end"
          side="top"
          sideOffset={8}
          collisionPadding={8}
          onCloseAutoFocus={(e) => e.preventDefault()}
          className={cn(
            "z-50 rounded-md border border-border bg-popover text-popover-foreground shadow-xl p-0",
            "w-[320px] sm:w-[420px] max-w-[calc(100vw-1.5rem)]",
            "data-[state=open]:animate-in data-[state=closed]:animate-out",
            "data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0",
            "data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95",
          )}
        >
          <div className="flex items-center justify-between px-3 pt-3 pb-2">
            <span className="text-[11px] uppercase tracking-wider font-medium text-muted-foreground">
              Modes
            </span>
            <span className="inline-flex items-center gap-1 text-[10px] text-muted-foreground/70">
              <kbd className="inline-flex items-center px-1 rounded border border-border bg-secondary text-[9px] font-mono">⇧</kbd>
              <span className="opacity-70">+</span>
              <kbd className="inline-flex items-center px-1 rounded border border-border bg-secondary text-[9px] font-mono">tab</kbd>
              <span className="opacity-70">to switch</span>
            </span>
          </div>

          <div className="px-1.5 pb-1">
            {MODE_OPTIONS.map((m) => {
              const Icon = m.icon;
              const active = m.value === currentMode;
              return (
                <button
                  key={m.value}
                  type="button"
                  onClick={() => {
                    onChange({ ...value, mode: m.value });
                    setOpen(false);
                  }}
                  className={cn(
                    "w-full text-left rounded-md px-2.5 py-2 flex items-start gap-2.5 transition-colors",
                    active
                      ? "bg-accent text-accent-foreground"
                      : "hover:bg-accent/60",
                  )}
                >
                  <Icon
                    className={cn(
                      "h-3.5 w-3.5 mt-0.5 shrink-0",
                      active ? "text-primary" : "text-muted-foreground",
                    )}
                  />
                  <div className="flex-1 min-w-0">
                    <div className="text-[12.5px] font-medium leading-tight text-foreground">
                      {m.label}
                    </div>
                    <p className="mt-0.5 text-[11px] leading-snug text-muted-foreground">
                      {m.hint}
                    </p>
                  </div>
                  {active && <Check className="h-3.5 w-3.5 text-foreground/80 shrink-0 mt-0.5" />}
                </button>
              );
            })}
          </div>

          <div className="border-t border-border px-3 py-2.5 flex items-center gap-3">
            <div className="flex items-center gap-1.5 text-[12.5px] font-medium text-foreground">
              <span className="inline-flex items-center justify-center h-4 w-4 rounded-sm border border-border text-muted-foreground">
                <svg viewBox="0 0 16 16" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="1.5">
                  <path d="M3 6h10M3 10h10" strokeLinecap="round" />
                  <circle cx="6" cy="6" r="1.5" fill="currentColor" />
                  <circle cx="10" cy="10" r="1.5" fill="currentColor" />
                </svg>
              </span>
              Effort
              <span className="text-muted-foreground font-normal">
                ({effortLabel})
              </span>
            </div>
            <div className="ml-auto inline-flex items-center gap-1.5 px-2 py-1 rounded-full bg-secondary/60 border border-border">
              {EFFORT_LEVELS.map((lvl, i) => {
                const filled = i <= effortIdx;
                return (
                  <button
                    key={lvl}
                    type="button"
                    onClick={() => onChange({ ...value, effort: lvl })}
                    title={lvl}
                    aria-label={`Effort: ${lvl}`}
                    className={cn(
                      "h-2 w-2 rounded-full transition-colors",
                      filled
                        ? "bg-foreground"
                        : "bg-muted-foreground/25 hover:bg-muted-foreground/50",
                    )}
                  />
                );
              })}
            </div>
          </div>
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}
