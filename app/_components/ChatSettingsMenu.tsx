"use client";

import { Settings2, Hand, Code2, ListTree, Zap, Cpu, Gauge } from "lucide-react";
import type { ChatSettings, PermissionMode, EffortLevel } from "@/lib/client/types";
import { Button } from "./ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./ui/select";

const MODE_OPTIONS: Array<{
  value: PermissionMode;
  label: string;
  hint: string;
  icon: React.ComponentType<{ size?: number; className?: string }>;
}> = [
  { value: "default",     label: "Ask before edits",   hint: "Approve each edit",                  icon: Hand },
  { value: "acceptEdits", label: "Edit automatically", hint: "Auto-apply edits to selected files", icon: Code2 },
  { value: "plan",        label: "Plan mode",          hint: "Explore and propose a plan first",   icon: ListTree },
  { value: "auto",        label: "Auto mode",          hint: "Pick the best mode per task",        icon: Zap },
];

const EFFORT_LEVELS: EffortLevel[] = ["low", "medium", "high", "max"];

const MODEL_PRESETS: Array<{ value: string; label: string }> = [
  { value: "__default__", label: "Default" },
  { value: "opus",        label: "Opus (latest)" },
  { value: "sonnet",      label: "Sonnet (latest)" },
  { value: "haiku",       label: "Haiku (latest)" },
];

export function ChatSettingsMenu({
  value,
  onChange,
}: {
  value: ChatSettings;
  onChange: (next: ChatSettings) => void;
}) {
  const currentMode = value.mode ?? "default";
  const currentMeta = MODE_OPTIONS.find((m) => m.value === currentMode) ?? MODE_OPTIONS[0];
  const ModeIcon = currentMeta.icon;
  const effortIdx = value.effort ? EFFORT_LEVELS.indexOf(value.effort) : EFFORT_LEVELS.length - 1;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="xs" title={currentMeta.label}>
          <ModeIcon className="h-3 w-3 text-primary" />
          <span className="font-medium">{currentMeta.label}</span>
          <Settings2 className="h-3 w-3 opacity-60" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-72">
        <DropdownMenuLabel>Modes</DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={currentMode}
          onValueChange={(v) => onChange({ ...value, mode: v as PermissionMode })}
        >
          {MODE_OPTIONS.map((m) => {
            const Icon = m.icon;
            return (
              <DropdownMenuRadioItem key={m.value} value={m.value} className="flex-col items-start py-1.5">
                <div className="flex items-center gap-2 w-full">
                  <Icon className="h-3 w-3 text-muted-foreground" />
                  <span>{m.label}</span>
                </div>
                <span className="pl-5 text-[10px] text-muted-foreground">{m.hint}</span>
              </DropdownMenuRadioItem>
            );
          })}
        </DropdownMenuRadioGroup>

        <DropdownMenuSeparator />
        <DropdownMenuLabel className="flex items-center gap-1">
          <Gauge className="h-3 w-3" /> Effort
        </DropdownMenuLabel>
        <div className="px-2 py-1.5 flex items-center gap-2">
          <div className="flex gap-1">
            {EFFORT_LEVELS.map((lvl, i) => (
              <button
                key={lvl}
                type="button"
                onClick={() => onChange({ ...value, effort: lvl })}
                className={`h-2 w-2 rounded-full transition-colors ${
                  i <= effortIdx ? "bg-primary" : "bg-muted border border-border"
                }`}
                title={lvl}
              />
            ))}
          </div>
          <span className="text-[11px] text-foreground ml-1">{value.effort ?? "max"}</span>
          <button
            type="button"
            onClick={() => onChange({ ...value, effort: undefined })}
            className="ml-auto text-[10px] text-muted-foreground hover:text-foreground"
          >
            reset
          </button>
        </div>

        <DropdownMenuSeparator />
        <DropdownMenuLabel className="flex items-center gap-1">
          <Cpu className="h-3 w-3" /> Model
        </DropdownMenuLabel>
        <div className="px-2 py-1.5">
          <Select
            value={value.model ?? "__default__"}
            onValueChange={(v) =>
              onChange({ ...value, model: v === "__default__" ? undefined : v })
            }
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {MODEL_PRESETS.map((p) => (
                <SelectItem key={p.value} value={p.value}>{p.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-[10px] text-muted-foreground mt-1">
            &quot;Default&quot; uses your <code>claude</code> CLI default.
          </p>
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
