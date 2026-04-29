"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import * as PopoverPrimitive from "@radix-ui/react-popover";
import pkg from "../../package.json";
import { api } from "@/libs/client/api";
import type { SlashCommandsItemDto } from "@/libs/client/types";
import { useToast } from "./Toasts";
import { cn } from "@/libs/cn";
import { Button } from "./ui/button";

const VERSION = (pkg as { version?: string }).version ?? "0.0.0";

const CLAUDE_DOCS = "https://docs.claude.com/claude-code";
const CLAUDE_CONSOLE = "https://console.anthropic.com/settings/usage";
const CLAUDE_GH_ISSUES = "https://github.com/anthropics/claude-code/issues";

/** Shown when a Claude Code REPL slash has no stdin equivalent (`claude -p` treats your text as plain prompt). */
const MSG_NO_REPL_SLASH =
  "This bridge runs one-shot prompts (stdin to claude -p), not an interactive terminal. Slash commands like /compact only run in live `claude` REPL — open Terminal and run `claude` there, or use menus here.";

const GROUP_ORDER = [
  "Context",
  "Model",
  "Customize",
  "Slash Commands",
  "Settings",
  "Support",
] as const;

interface MenuAction {
  id: string;
  label: string;
  group: (typeof GROUP_ORDER)[number];
  hint?: string;
  disabled?: boolean;
  run: () => void;
}

/**
 * Composer `/` palette — Claude-style filter + grouped actions (matches
 * the multi-section menu from Claude Desktop tabs). Anchors to the `/`
 * Trigger and pops upward, left-aligned with the trigger.
 */
export function SlashActionsPalette({
  open,
  onOpenChange,
  repo,
  onSlashInsert,
  onAttach,
  onMention,
  onClear,
  onRewind,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** App folder name (`bridge.json`); drives `/api/repos/<repo>/slash-commands`. */
  repo: string;
  onSlashInsert: (text: string) => void;
  onAttach: () => void;
  onMention: () => void;
  onClear?: () => void;
  onRewind?: () => void;
}) {
  const router = useRouter();
  const toast = useToast();
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [busyLogout, setBusyLogout] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const handleOpenChange = useCallback(
    (next: boolean) => {
      setQuery("");
      onOpenChange(next);
    },
    [onOpenChange],
  );

  /** Always clears the filter bar — callers must never use bare `onOpenChange(false)` or reopening leaks the previous query. */
  const close = useCallback(() => {
    handleOpenChange(false);
  }, [handleOpenChange]);

  useEffect(() => {
    if (!open) return;
    const id = requestAnimationFrame(() => inputRef.current?.focus());
    return () => cancelAnimationFrame(id);
  }, [open]);

  const navigate = useCallback(
    (path: string) => {
      router.push(path);
      close();
    },
    [router, close],
  );
  const externalOpen = useCallback(
    (url: string) => {
      window.open(url, "_blank", "noopener");
      close();
    },
    [close],
  );

  const noopReplSlash = useCallback(() => {
    toast("info", MSG_NO_REPL_SLASH);
    close();
  }, [toast, close]);

  const switchAccount = useCallback(async () => {
    if (busyLogout) return;
    setBusyLogout(true);
    try {
      await fetch("/api/auth/logout", { method: "POST" });
    } finally {
      window.location.replace("/login");
    }
  }, [busyLogout]);

  const [slashItems, setSlashItems] = useState<SlashCommandsItemDto[]>([]);
  const [slashLoading, setSlashLoading] = useState(false);

  useEffect(() => {
    if (!open || !repo?.trim()) return;
    let cancelled = false;
    void (async () => {
      await Promise.resolve();
      if (cancelled) return;
      setSlashItems([]);
      setSlashLoading(true);
      try {
        const r = await api.repoSlashCommands(repo);
        if (!cancelled) setSlashItems(r.items);
      } catch {
        if (!cancelled) {
          setSlashItems([]);
          toast("error", "Could not load slash commands.");
        }
      } finally {
        if (!cancelled) setSlashLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, repo, toast]);

  const runBuiltinSlug = useCallback(
    (slug: string) => {
      switch (slug) {
        case "clear":
          if (!onClear) {
            toast("info", "Clear isn’t available here.");
            close();
            return;
          }
          onClear();
          close();
          return;
        case "rewind":
          if (onRewind) {
            onRewind();
            close();
            return;
          }
          noopReplSlash();
          return;
        case "help":
          externalOpen(CLAUDE_DOCS);
          return;
        case "cost":
        case "usage":
          externalOpen(CLAUDE_CONSOLE);
          return;
        case "model":
          toast("info", "Use the Mode menu (left of Send) to pick model & effort.");
          close();
          return;
        case "init":
          toast(
            "info",
            "Run `claude` in a terminal and use `/init` there to scaffold CLAUDE.md — the bridge sends plain prompts, not interactive REPL slash control.",
          );
          close();
          return;
        case "resume":
          toast(
            "info",
            "This chat already continues a session. Switch threads from the sidebar or open a session from /sessions.",
          );
          close();
          return;
        case "agents":
          navigate("/apps");
          return;
        case "permissions":
        case "config":
          navigate("/settings");
          return;
        case "hooks":
          externalOpen(`${CLAUDE_DOCS}/hooks`);
          return;
        case "mcp":
          externalOpen(`${CLAUDE_DOCS}/mcp`);
          return;
        case "memory":
          toast(
            "info",
            "Project memory edits use `/memory` inside an interactive `claude` terminal session — see docs.",
          );
          externalOpen(`${CLAUDE_DOCS}/memory`);
          return;
        case "bug":
          externalOpen(CLAUDE_GH_ISSUES);
          return;
        default:
          noopReplSlash();
      }
    },
    [onClear, onRewind, toast, close, externalOpen, navigate, noopReplSlash],
  );

  const staticPaletteActions: MenuAction[] = useMemo(
    () => [
      {
        id: "attach",
        label: "Attach file…",
        hint: "max 25 MB",
        group: "Context",
        run: () => {
          onAttach();
          close();
        },
      },
      {
        id: "mention",
        label: "Mention file from this project…",
        group: "Context",
        run: () => {
          onMention();
          close();
        },
      },
      {
        id: "clear",
        label: "Clear conversation",
        group: "Context",
        disabled: !onClear,
        run: () => {
          onClear?.();
          close();
        },
      },
      {
        id: "rewind",
        label: "Rewind…",
        group: "Context",
        disabled: !onRewind,
        run: () => {
          onRewind?.();
          close();
        },
      },

      {
        id: "switch-model",
        label: "Switch model…",
        hint: "Default (recommended)",
        group: "Model",
        run: () => {
          toast("info", "Use the Mode picker to the left of Send");
          close();
        },
      },
      {
        id: "effort",
        label: "Effort",
        hint: "(Max)",
        group: "Model",
        run: () => {
          toast("info", "Adjust Effort in the Mode picker (left of Send)");
          close();
        },
      },
      {
        id: "thinking",
        label: "Thinking",
        group: "Model",
        run: () => {
          toast("info", "Thinking options live in Claude Code CLI when running interactively; use Mode picker here for presets.");
          close();
        },
      },
      {
        id: "account",
        label: "Account & usage…",
        group: "Model",
        run: () => externalOpen(CLAUDE_CONSOLE),
      },

      {
        id: "output-styles",
        label: "Output styles",
        hint: "interactive REPL",
        group: "Customize",
        run: () => {
          toast(
            "info",
            "In Claude Code, run `claude` in Terminal then `/output-style` — the bridge forwards typed text as prompts, not REPL slash commands.",
          );
          close();
        },
      },
      {
        id: "agents",
        label: "Agents",
        group: "Customize",
        run: () => navigate("/apps"),
      },
      {
        id: "hooks",
        label: "Hooks",
        group: "Customize",
        run: () => externalOpen(`${CLAUDE_DOCS}/hooks`),
      },
      {
        id: "memory",
        label: "Memory",
        hint: "interactive REPL",
        group: "Customize",
        run: () => {
          toast(
            "info",
            "Project memory edits use `/memory` inside an interactive `claude` terminal session — see docs.",
          );
          externalOpen(`${CLAUDE_DOCS}/memory`);
        },
      },
      {
        id: "permissions",
        label: "Permissions",
        group: "Customize",
        run: () => navigate("/settings"),
      },
      {
        id: "mcp",
        label: "MCP servers",
        group: "Customize",
        run: () => externalOpen(`${CLAUDE_DOCS}/mcp`),
      },
      {
        id: "plugins",
        label: "Manage plugins",
        group: "Customize",
        run: () => externalOpen(`${CLAUDE_DOCS}/plugins`),
      },
      {
        id: "open-cli",
        label: "Open Claude in Terminal",
        group: "Customize",
        run: async () => {
          try {
            await navigator.clipboard.writeText("claude");
            toast("info", "Copied `claude` — paste in your terminal");
          } catch {
            toast("error", "Clipboard blocked");
          }
          close();
        },
      },


      {
        id: "switch-account",
        label: "Switch account",
        group: "Settings",
        disabled: busyLogout,
        run: () => void switchAccount(),
      },
      {
        id: "general-config",
        label: "General config…",
        group: "Settings",
        run: () => navigate("/settings"),
      },
      {
        id: "tasks",
        label: "Tasks",
        group: "Settings",
        run: () => navigate("/tasks"),
      },
      {
        id: "sessions",
        label: "Sessions",
        group: "Settings",
        run: () => navigate("/sessions"),
      },

      {
        id: "help-docs",
        label: "View help docs",
        group: "Support",
        run: () => externalOpen(CLAUDE_DOCS),
      },
      {
        id: "report",
        label: "Report a problem",
        group: "Support",
        run: () => externalOpen(CLAUDE_GH_ISSUES),
      },
    ],
    [
      onAttach,
      onClear,
      onMention,
      onRewind,
      busyLogout,
      toast,
      close,
      navigate,
      externalOpen,
      switchAccount,
    ],
  );

  const slashMenuActions: MenuAction[] = useMemo(() => {
    if (!repo?.trim()) return [];
    if (slashLoading && slashItems.length === 0) {
      return [
        {
          id: "slash-loading",
          label: "Loading slash commands…",
          group: "Slash Commands",
          disabled: true,
          run: () => {},
        },
      ];
    }
    return slashItems.map((item): MenuAction => {
      const hintParts: string[] = [];
      if (item.description?.trim()) {
        const t = item.description!.trim();
        hintParts.push(t.length > 56 ? `${t.slice(0, 53)}…` : t);
      }
      hintParts.push(
        item.source === "project"
          ? "project"
          : item.source === "user"
            ? "user"
            : "built-in",
      );
      const label = item.slug.startsWith("/") ? item.slug : `/${item.slug}`;

      return {
        id: `slash-${item.source}-${encodeURIComponent(item.slug)}`,
        label,
        hint: hintParts.join(" · "),
        group: "Slash Commands",
        run: () => {
          if (item.source === "project" || item.source === "user") {
            onSlashInsert(`/${item.slug} `);
            close();
            return;
          }
          runBuiltinSlug(item.slug);
        },
      };
    });
  }, [repo, slashLoading, slashItems, onSlashInsert, close, runBuiltinSlug]);

  const actions = useMemo(
    () => [...staticPaletteActions, ...slashMenuActions],
    [staticPaletteActions, slashMenuActions],
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return actions;
    return actions.filter(
      (a) =>
        a.id.toLowerCase().includes(q) ||
        a.label.toLowerCase().includes(q) ||
        a.group.toLowerCase().includes(q) ||
        (a.hint?.toLowerCase().includes(q) ?? false),
    );
  }, [actions, query]);

  const grouped = useMemo(() => {
    const map = new Map<string, MenuAction[]>();
    for (const a of filtered) {
      if (!map.has(a.group)) map.set(a.group, []);
      map.get(a.group)!.push(a);
    }
    return GROUP_ORDER.filter((g) => map.has(g)).map((g) => ({
      name: g,
      items: map.get(g)!,
    }));
  }, [filtered]);

  const effectiveSelectedId = useMemo(() => {
    if (!open || filtered.length === 0) return null;
    if (selectedId && filtered.some((a) => a.id === selectedId)) return selectedId;
    return filtered.find((a) => !a.disabled)?.id ?? filtered[0]?.id ?? null;
  }, [open, filtered, selectedId]);

  useEffect(() => {
    if (!open || !effectiveSelectedId) return;
    const el = document.querySelector<HTMLElement>(
      `[data-slash-item="${CSS.escape(effectiveSelectedId)}"]`,
    );
    el?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [effectiveSelectedId, open]);

  const moveSelection = useCallback(
    (dir: 1 | -1) => {
      setSelectedId((cur) => {
        const ids = filtered.filter((a) => !a.disabled).map((a) => a.id);
        if (!ids.length) return null;
        const i = cur ? ids.indexOf(cur) : -1;
        if (i === -1) return dir > 0 ? ids[0] : ids[ids.length - 1];
        const n = (i + dir + ids.length) % ids.length;
        return ids[n];
      });
    },
    [filtered],
  );

  return (
    <PopoverPrimitive.Root open={open} onOpenChange={handleOpenChange}>
      <PopoverPrimitive.Trigger asChild>
        <Button
          type="button"
          variant="outline"
          size="iconSm"
          title="All actions"
          aria-label="All actions"
          className="font-mono text-[13px] font-semibold min-w-7.5"
        >
          /
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
            "z-50 rounded-md border border-border bg-popover text-popover-foreground shadow-xl flex flex-col",
            "w-[320px] sm:w-[420px] max-w-[calc(100vw-1.5rem)]",
            "max-h-[min(70vh,520px)] overflow-hidden",
            "data-[state=open]:animate-in data-[state=closed]:animate-out",
            "data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0",
            "data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95",
          )}
        >
          <div className="p-2 border-b border-border shrink-0">
            <div className="flex items-center px-2 py-1.5 rounded-md border border-border bg-background focus-within:border-primary/60">
              <input
                ref={inputRef}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Escape") {
                    e.preventDefault();
                    handleOpenChange(false);
                    return;
                  }
                  if (e.key === "ArrowDown") {
                    e.preventDefault();
                    moveSelection(1);
                    return;
                  }
                  if (e.key === "ArrowUp") {
                    e.preventDefault();
                    moveSelection(-1);
                    return;
                  }
                  if (e.key === "Enter" && filtered.length > 0) {
                    e.preventDefault();
                    const selected = effectiveSelectedId
                      ? filtered.find(
                          (a) => a.id === effectiveSelectedId && !a.disabled,
                        )
                      : undefined;
                    const pick = selected ?? filtered.find((a) => !a.disabled);
                    pick?.run();
                  }
                }}
                placeholder="Filter actions…"
                className="w-full bg-transparent border-0 outline-none text-xs placeholder:text-muted-foreground"
                aria-label="Filter actions"
              />
            </div>
          </div>

          <div className="overflow-y-auto flex-1 min-h-0 py-1">
            {grouped.length === 0 ? (
              <div className="px-3 py-6 text-center text-xs text-muted-foreground">
                No actions match
              </div>
            ) : (
              grouped.map((g, gi) => (
                <div key={g.name}>
                  {gi > 0 && <div className="mx-3 my-1 h-px bg-border/60" />}
                  <div className="px-3 pt-1 pb-0.5 text-[10px] uppercase tracking-wider font-medium text-muted-foreground">
                    {g.name}
                  </div>
                  {g.items.map((it) => {
                    const hi = effectiveSelectedId === it.id;
                    return (
                      <button
                        key={it.id}
                        type="button"
                        data-slash-item={it.id}
                        disabled={it.disabled}
                        onMouseEnter={() => setSelectedId(it.id)}
                        onClick={it.run}
                        className={cn(
                          "w-full flex items-center gap-2 px-3 py-1.5 text-xs text-left",
                          "hover:bg-accent hover:text-accent-foreground transition-colors",
                          "disabled:opacity-40 disabled:pointer-events-none",
                          hi &&
                            "bg-accent/70 text-accent-foreground ring-inset ring-1 ring-primary/35",
                        )}
                      >
                        <span className="flex-1 min-w-0 truncate text-foreground">
                          {it.label}
                        </span>
                        {it.hint && (
                          <span className="shrink-0 text-[10px] text-muted-foreground max-w-[45%] truncate">
                            {it.hint}
                          </span>
                        )}
                      </button>
                    );
                  })}
                </div>
              ))
            )}
          </div>

          <div className="border-t border-border px-3 py-1.5 flex items-center gap-2 text-[10px] text-muted-foreground/70 shrink-0 justify-between">
            <span className="truncate min-w-0">
              Slash list: ~/.claude + repo `.claude/` + built-ins (JSON). REPL:&nbsp;
              <kbd className="px-1 rounded bg-muted">claude</kbd>
            </span>
            <span className="tabular-nums shrink-0">v{VERSION}</span>
          </div>
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}
