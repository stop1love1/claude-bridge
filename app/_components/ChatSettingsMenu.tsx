"use client";

import { useState } from "react";
import { Hand, Code2, ListTree, Zap, Check, ShieldOff } from "lucide-react";
import * as PopoverPrimitive from "@radix-ui/react-popover";
import type { ChatSettings, PermissionMode } from "@/libs/client/types";
import { Button } from "./ui/button";
import { EffortControl } from "./EffortControl";
import { ModelPicker } from "./ModelPicker";
import { cn } from "@/libs/cn";

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
  ...(process.env.NEXT_PUBLIC_BRIDGE_ALLOW_BYPASS === "1"
    ? [
        {
          value: "bypassPermissions" as const,
          label: "Skip permissions",
          hint: "No popup — Claude runs every tool call without asking. Use only on a trusted single-user machine.",
          icon: ShieldOff,
        },
      ]
    : []),
];

export function ChatSettingsMenu({
  value,
  onChange,
  sessionModel = null,
}: {
  value: ChatSettings;
  onChange: (next: ChatSettings) => void;
  /**
   * `Run.model` for the session this composer talks to, when it has one. A
   * continuation inherits it unless the operator says otherwise, so the picker
   * has to both show it and offer a way out — see the picker below.
   */
  sessionModel?: string | null;
}) {
  const [open, setOpen] = useState(false);

  const currentMode = value.mode ?? "default";
  const currentMeta = MODE_OPTIONS.find((m) => m.value === currentMode) ?? MODE_OPTIONS[0];
  const ModeIcon = currentMeta.icon;
  /** The next turn will run on the session's own pin — nothing overrides it yet. */
  const inheritsSessionModel = !!sessionModel && !value.model && !value.clearModel;

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

          <div className="border-t border-border px-3 py-2.5">
            <div className="text-[11px] uppercase tracking-wider font-medium text-muted-foreground mb-1">
              Select a model
            </div>
            {inheritsSessionModel && (
              <p className="text-[11px] leading-snug text-muted-foreground mb-1.5">
                This session was started on{" "}
                <code className="font-mono text-foreground">{sessionModel}</code> and
                keeps using it. Pick another model, or Default to stop pinning it.
              </p>
            )}
            <ModelPicker
              enabled={open}
              // With nothing chosen this turn, the picker shows the model the
              // session is actually going to run on — the inherited pin — so
              // "Default" reads as a change rather than as the current state.
              value={value.model ?? (inheritsSessionModel ? sessionModel! : undefined)}
              onChange={(model) => {
                const next = { ...value };
                delete next.model;
                delete next.clearModel;
                if (model) {
                  onChange({ ...next, model });
                  return;
                }
                // Default on a pinned session is a real instruction, not a
                // no-op: without the flag the server re-pins `sessionModel`.
                if (sessionModel) next.clearModel = true;
                onChange(next);
              }}
              defaultDescription={
                sessionModel
                  ? "Stop pinning this session; fall back to the task/app pin or your CLI default"
                  : "Whatever model your Claude CLI is configured to use"
              }
            />
          </div>

          <div className="border-t border-border px-3 py-2.5">
            <EffortControl
              value={value.effort}
              onChange={(effort) => onChange({ ...value, effort })}
            />
          </div>
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}
