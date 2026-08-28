"use client";

import { useEffect, useState } from "react";
import { Hand, Code2, ListTree, Zap, Check, ShieldOff } from "lucide-react";
import * as PopoverPrimitive from "@radix-ui/react-popover";
import { api } from "@/libs/client/api";
import type { ChatSettings, ModelChoice, PermissionMode } from "@/libs/client/types";
import { Button } from "./ui/button";
import { EffortControl } from "./EffortControl";
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

function ModelRow({
  label,
  hint,
  description,
  active,
  onSelect,
}: {
  label: string;
  hint?: string;
  description: string;
  active: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={active}
      className={cn(
        "w-full text-left rounded-md px-2.5 py-1.5 flex items-start gap-2.5 transition-colors",
        active ? "bg-accent text-accent-foreground" : "hover:bg-accent/60",
      )}
    >
      <div className="flex-1 min-w-0">
        <div className="text-[12.5px] font-medium leading-tight text-foreground">
          {label}
          {hint && <span className="font-normal text-muted-foreground"> ({hint})</span>}
        </div>
        <p className="mt-0.5 text-[11px] leading-snug text-muted-foreground">
          {description}
        </p>
      </div>
      {active && <Check className="h-3.5 w-3.5 text-foreground/80 shrink-0 mt-0.5" />}
    </button>
  );
}

export function ChatSettingsMenu({
  value,
  onChange,
}: {
  value: ChatSettings;
  onChange: (next: ChatSettings) => void;
}) {
  const [open, setOpen] = useState(false);
  const [models, setModels] = useState<ModelChoice[] | null>(null);
  const [modelsFailed, setModelsFailed] = useState(false);

  // Fetched when the menu first opens, not on mount: discovery shells out to
  // the CLI, and most composer renders never show this panel.
  useEffect(() => {
    if (!open || models !== null || modelsFailed) return;
    let cancelled = false;
    void api
      .models()
      .then((r) => {
        if (!cancelled) setModels(r.models);
      })
      .catch(() => {
        if (!cancelled) setModelsFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [open, models, modelsFailed]);

  const currentMode = value.mode ?? "default";
  const currentMeta = MODE_OPTIONS.find((m) => m.value === currentMode) ?? MODE_OPTIONS[0];
  const ModeIcon = currentMeta.icon;

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
            <div className="-mx-1.5">
              <ModelRow
                label="Default"
                hint="recommended"
                description="Whatever model your Claude CLI is configured to use"
                active={!value.model}
                onSelect={() => {
                  const next = { ...value };
                  delete next.model;
                  onChange(next);
                }}
              />
              {(models ?? []).map((m) => (
                <ModelRow
                  key={m.value}
                  label={m.label}
                  description={
                    m.description ??
                    (m.source === "seen"
                      ? `Run on this machine · ${m.value}`
                      : `Passed to the CLI as --model ${m.value}`)
                  }
                  active={value.model === m.value}
                  onSelect={() => onChange({ ...value, model: m.value })}
                />
              ))}
            </div>
            {(models === null || modelsFailed) && (
              <p className="px-1.5 pt-1 text-[11px] leading-snug text-muted-foreground">
                {modelsFailed
                  ? "Could not read the model list from the Claude CLI — Default still works."
                  : "Reading the model list from your Claude CLI…"}
              </p>
            )}
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
