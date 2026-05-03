import { useState } from "react";
import {
  Hand,
  Code2,
  ListTree,
  ShieldOff,
  Check,
  Settings as SettingsIcon,
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";
import type { ChatSettings, PermissionMode } from "@/api/types";

// Mode picker + model picker + tool allowlists. Anchored to a "settings"
// pill in the composer's bottom row. Pops upward, right-aligned.
//
// Backend doesn't enumerate models today, so we ship a small static
// list of common Claude releases. Operators can extend the list when
// the backend grows a /models endpoint.

// Lucide icons are ForwardRefExoticComponents — typing the slot as
// `ComponentType<any>` keeps `<Icon className="…">` ergonomic without
// fighting RefAttributes through strict-mode prop types.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type IconComponent = React.ComponentType<any>;

const MODE_OPTIONS: Array<{
  value: PermissionMode;
  label: string;
  hint: string;
  icon: IconComponent;
}> = [
  {
    value: "default",
    label: "Ask before edits",
    hint: "Claude asks for approval before each tool call",
    icon: Hand,
  },
  {
    value: "acceptEdits",
    label: "Edit automatically",
    hint: "Edits apply without prompting",
    icon: Code2,
  },
  {
    value: "plan",
    label: "Plan mode",
    hint: "Explore + plan before editing",
    icon: ListTree,
  },
  {
    value: "bypassPermissions",
    label: "Skip permissions",
    hint: "No popups — every tool runs. Trusted workstations only.",
    icon: ShieldOff,
  },
];

const MODEL_OPTIONS: Array<{ value: string; label: string }> = [
  { value: "", label: "Default (recommended)" },
  { value: "claude-opus-4-7", label: "Opus 4.7" },
  { value: "claude-sonnet-4-6", label: "Sonnet 4.6" },
  { value: "claude-haiku-4-5", label: "Haiku 4.5" },
];

function csvToList(s: string): string[] {
  return s
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
}

export function ChatSettingsMenu({
  value,
  onChange,
}: {
  value: ChatSettings;
  onChange: (next: ChatSettings) => void;
}) {
  const [open, setOpen] = useState(false);
  const currentMode = value.mode ?? "default";
  const currentMeta =
    MODE_OPTIONS.find((m) => m.value === currentMode) ?? MODE_OPTIONS[0];
  const ModeIcon = currentMeta.icon;

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="xs"
          title={currentMeta.label}
          className="gap-1.5"
        >
          <ModeIcon className="h-3 w-3 text-accent" />
          <span className="font-medium">{currentMeta.label}</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        side="top"
        className="w-[340px] sm:w-[400px] p-0"
      >
        <DropdownMenuLabel>Mode</DropdownMenuLabel>
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
                }}
                className={cn(
                  "w-full text-left rounded-sm px-2.5 py-2 flex items-start gap-2.5 transition-colors",
                  active ? "bg-surface text-fg" : "hover:bg-surface/60",
                )}
              >
                <Icon
                  className={cn(
                    "h-3.5 w-3.5 mt-0.5 shrink-0",
                    active ? "text-accent" : "text-muted",
                  )}
                />
                <div className="flex-1 min-w-0">
                  <div className="text-[12px] font-medium leading-tight text-fg">
                    {m.label}
                  </div>
                  <p className="mt-0.5 text-[11px] leading-snug text-muted">
                    {m.hint}
                  </p>
                </div>
                {active && (
                  <Check className="h-3.5 w-3.5 text-fg shrink-0 mt-0.5" />
                )}
              </button>
            );
          })}
        </div>
        <DropdownMenuSeparator />
        <DropdownMenuLabel>Model</DropdownMenuLabel>
        <div className="px-1.5 pb-1">
          {MODEL_OPTIONS.map((m) => {
            const active = (value.model ?? "") === m.value;
            return (
              <button
                key={m.value || "_default"}
                type="button"
                onClick={() => {
                  onChange({
                    ...value,
                    model: m.value ? m.value : undefined,
                  });
                }}
                className={cn(
                  "w-full text-left rounded-sm px-2.5 py-1.5 flex items-center gap-2 text-[12px] font-mono transition-colors",
                  active ? "bg-surface text-fg" : "hover:bg-surface/60 text-fg",
                )}
              >
                <span className="flex-1 truncate">{m.label}</span>
                {active && <Check className="h-3 w-3 text-accent" />}
              </button>
            );
          })}
        </div>
        <DropdownMenuSeparator />
        <div className="px-3 py-2 space-y-2">
          <div className="flex items-center gap-1.5 text-micro uppercase tracking-wideish text-muted">
            <SettingsIcon className="h-3 w-3" />
            <span>Tool gates</span>
          </div>
          <label className="block">
            <span className="block text-[10px] uppercase tracking-wideish text-muted mb-1">
              Allowed tools (csv)
            </span>
            <Input
              defaultValue={(value.allowedTools ?? []).join(", ")}
              placeholder="Read, Edit, Bash"
              onBlur={(e) =>
                onChange({
                  ...value,
                  allowedTools: csvToList(e.currentTarget.value),
                })
              }
            />
          </label>
          <label className="block">
            <span className="block text-[10px] uppercase tracking-wideish text-muted mb-1">
              Disallowed tools (csv)
            </span>
            <Input
              defaultValue={(value.disallowedTools ?? []).join(", ")}
              placeholder="WebFetch"
              onBlur={(e) =>
                onChange({
                  ...value,
                  disallowedTools: csvToList(e.currentTarget.value),
                })
              }
            />
          </label>
          <p className="text-[10px] text-muted">
            Tip: tool gates apply to the next message; current run keeps
            the gates it was launched with.
          </p>
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
