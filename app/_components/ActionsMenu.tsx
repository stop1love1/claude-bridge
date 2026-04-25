"use client";

import { Plus, Paperclip, AtSign, Trash2, Undo2, Cpu, Gauge, Brain, ExternalLink } from "lucide-react";
import { Button } from "./ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu";

export type ActionId =
  | "attach" | "mention" | "clear" | "rewind"
  | "switch-model" | "effort" | "thinking"
  | "account";

interface ActionItem {
  id: ActionId;
  label: string;
  hint?: string;
  group: "Context" | "Model" | "Account";
  icon: React.ComponentType<{ size?: number; className?: string }>;
}

const ACTIONS: ActionItem[] = [
  { id: "attach",       label: "Attach file…",                    group: "Context", icon: Paperclip },
  { id: "mention",      label: "Mention file from this project…", group: "Context", icon: AtSign },
  { id: "clear",        label: "Clear conversation",              group: "Context", icon: Trash2 },
  { id: "rewind",       label: "Rewind…",                         group: "Context", icon: Undo2 },
  { id: "switch-model", label: "Switch model…",                   group: "Model",   icon: Cpu },
  { id: "effort",       label: "Effort",                          group: "Model",   icon: Gauge },
  { id: "thinking",     label: "Thinking",                        group: "Model",   icon: Brain },
  { id: "account",      label: "Account & usage…",                group: "Account", icon: ExternalLink },
];

export function ActionsMenu({
  onPick,
  disabled,
}: {
  onPick: (id: ActionId) => void;
  disabled?: Partial<Record<ActionId, boolean>>;
}) {
  const groupNames: Array<ActionItem["group"]> = ["Context", "Model", "Account"];

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="iconSm" title="Actions">
          <Plus className="h-3.5 w-3.5" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-72">
        {groupNames.map((group, gi) => {
          const items = ACTIONS.filter((a) => a.group === group);
          if (items.length === 0) return null;
          return (
            <div key={group}>
              {gi > 0 && <DropdownMenuSeparator />}
              <DropdownMenuLabel>{group}</DropdownMenuLabel>
              {items.map((it) => {
                const Icon = it.icon;
                return (
                  <DropdownMenuItem
                    key={it.id}
                    disabled={disabled?.[it.id]}
                    onSelect={() => onPick(it.id)}
                  >
                    <Icon className="h-3.5 w-3.5 text-muted-foreground" />
                    <span>{it.label}</span>
                  </DropdownMenuItem>
                );
              })}
            </div>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
