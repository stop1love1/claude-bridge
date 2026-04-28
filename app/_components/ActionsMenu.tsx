"use client";

import { useState } from "react";
import { Plus, Upload, FileText } from "lucide-react";
import * as PopoverPrimitive from "@radix-ui/react-popover";
import { Button } from "./ui/button";
import { cn } from "@/lib/cn";

/**
 * Composer "+" — Claude Desktop short menu: upload + @ mention for context.
 */
export function QuickAddMenu({
  onAttach,
  onMention,
}: {
  onAttach: () => void;
  onMention: () => void;
}) {
  const [open, setOpen] = useState(false);

  return (
    <PopoverPrimitive.Root open={open} onOpenChange={setOpen}>
      <PopoverPrimitive.Trigger asChild>
        <Button
          type="button"
          variant="outline"
          size="iconSm"
          title="Add"
          aria-label="Add"
          aria-expanded={open}
          aria-haspopup="dialog"
        >
          <Plus className="h-3.5 w-3.5" />
        </Button>
      </PopoverPrimitive.Trigger>
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content
          align="start"
          side="top"
          sideOffset={8}
          collisionPadding={8}
          onCloseAutoFocus={(e) => e.preventDefault()}
          className={cn(
            "z-50 w-[220px] rounded-lg border border-border bg-popover text-popover-foreground shadow-xl p-1",
            "data-[state=open]:animate-in data-[state=closed]:animate-out",
            "data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0",
            "data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95",
          )}
        >
          <ActionRow
            icon={Upload}
            label="Upload from computer"
            onClick={onAttach}
          />
          <ActionRow
            icon={FileText}
            label="Add context"
            onClick={onMention}
          />
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}

function ActionRow({
  icon: Icon,
  label,
  onClick,
}: {
  icon: React.ComponentType<{ className?: string; size?: number }>;
  label: string;
  onClick: () => void;
}) {
  return (
    <PopoverPrimitive.Close asChild>
      <button
        type="button"
        onClick={onClick}
        className={cn(
          "w-full flex items-center gap-2.5 px-2.5 py-2 rounded-md text-[13px] text-left",
          "hover:bg-accent hover:text-accent-foreground transition-colors",
        )}
      >
        <Icon className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
        <span className="flex-1 min-w-0 truncate">{label}</span>
      </button>
    </PopoverPrimitive.Close>
  );
}
