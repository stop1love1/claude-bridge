import { useEffect, useMemo, useRef, useState } from "react";
import { Terminal } from "lucide-react";
import { useRepoSlashCommands } from "@/api/queries";
import type { SlashCommandsItemDto } from "@/api/types";
import { cn } from "@/lib/cn";

// Floating `/`-palette over the composer textarea. Fetches
// /api/repos/{repo}/slash-commands and filters by the typed prefix.
//
// Unlike the main repo's huge multi-section palette (which mixed
// model/agent/customize/etc actions), this version focuses on what
// `/` is for in the composer: insert a slash command. Other navigation
// has its own surfaces (CommandPalette, ChatSettingsMenu, MainNav).

export function SlashActionsPalette({
  open,
  onOpenChange,
  repo,
  query,
  onPick,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** App folder name (`bridge.json`). Drives the slash list endpoint. */
  repo: string;
  /** Text after the leading `/`. Driven by the composer's draft. */
  query: string;
  /** Insert text at the caret (e.g. `/clear `). */
  onPick: (text: string) => void;
}) {
  const { data, isLoading } = useRepoSlashCommands(open ? repo : undefined);
  const [cursor, setCursor] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);

  const items = useMemo<SlashCommandsItemDto[]>(() => {
    if (!data) return [];
    const q = query.trim().toLowerCase();
    if (!q) return data.items;
    return data.items.filter(
      (it) =>
        it.slug.toLowerCase().includes(q) ||
        (it.description ?? "").toLowerCase().includes(q),
    );
  }, [data, query]);

  // Reset cursor when the filter narrows past the current pick.
  if (cursor > 0 && cursor >= items.length) {
    // Render-time clamp keeps the linter happy (no setState-in-effect).
    setCursor(0);
  }

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onOpenChange(false);
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        setCursor((c) => Math.min(items.length - 1, c + 1));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setCursor((c) => Math.max(0, c - 1));
      } else if (e.key === "Enter" || e.key === "Tab") {
        const pick = items[cursor];
        if (pick) {
          e.preventDefault();
          onPick(`/${pick.slug} `);
          onOpenChange(false);
        }
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, items, cursor, onPick, onOpenChange]);

  // Click-outside close. Mouse events on the textarea would dismiss
  // anyway via Esc/Enter, but operators clicking elsewhere expect the
  // popover to dissolve.
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      const c = containerRef.current;
      if (!c) return;
      if (!c.contains(e.target as Node)) onOpenChange(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open, onOpenChange]);

  if (!open) return null;

  return (
    <div
      ref={containerRef}
      className="absolute bottom-full mb-2 left-0 right-0 max-w-md bg-card border border-border rounded-md shadow-2xl z-40 overflow-hidden animate-fade-up"
      role="listbox"
      aria-label="Slash commands"
    >
      <div className="px-3 py-1.5 border-b border-border flex items-center gap-2 text-micro uppercase tracking-wideish text-muted-foreground">
        <Terminal size={11} />
        Slash commands
        <span className="ml-auto font-mono normal-case text-muted-foreground">/{query}</span>
      </div>
      <ul className="max-h-72 overflow-y-auto py-1">
        {isLoading ? (
          <li className="px-3 py-2 text-xs text-muted-foreground italic">Loading…</li>
        ) : items.length === 0 ? (
          <li className="px-3 py-2 text-xs text-muted-foreground italic">
            No commands match
          </li>
        ) : (
          items.map((it, i) => (
            <li key={`${it.source}:${it.slug}`}>
              <button
                type="button"
                role="option"
                aria-selected={i === cursor}
                onMouseEnter={() => setCursor(i)}
                onMouseDown={(e) => {
                  e.preventDefault();
                  onPick(`/${it.slug} `);
                  onOpenChange(false);
                }}
                className={cn(
                  "w-full flex items-center gap-3 px-3 py-1.5 text-left transition-colors",
                  i === cursor ? "bg-secondary" : "hover:bg-secondary/60",
                )}
              >
                <span className="font-mono text-xs text-foreground">/{it.slug}</span>
                <span className="text-[11px] text-muted-foreground truncate flex-1">
                  {it.description ?? ""}
                </span>
                <span className="text-[10px] text-muted-foreground/70 uppercase tracking-wideish">
                  {it.source}
                </span>
              </button>
            </li>
          ))
        )}
      </ul>
      <div className="px-3 py-1 border-t border-border bg-secondary text-[10px] text-muted-foreground">
        ↑↓ move · ↵/Tab insert · Esc cancel
      </div>
    </div>
  );
}
