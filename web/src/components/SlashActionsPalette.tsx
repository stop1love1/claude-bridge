import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Terminal } from "lucide-react";
import { useRepoSlashCommands } from "@/api/queries";
import type { SlashCommandsItemDto } from "@/api/types";
import { useToast } from "@/components/Toasts";
import { useTheme } from "@/components/ThemeProvider";
import { cn } from "@/lib/cn";
import { version as PKG_VERSION } from "../../package.json";

// Floating `/`-palette anchored to the composer textarea. Caller
// controls `open`/`query` (driven by what comes after the leading `/`
// in the draft); this component renders the action surface itself.
//
// This is the SPA port of main's grouped multi-section palette
// (Context · Model · Customize · Slash Commands · Settings · Support)
// adapted to the SPA's existing in-composer anchor and its
// `onPick(text)` insert contract. The original simple-list version
// only filtered slash entries; this one merges built-in actions with
// the dynamic slash-command list and routes a curated set of slugs
// (`/clear`, `/help`, `/cost`, …) to the right destination.

const VERSION = PKG_VERSION ?? "0.0.0";

const CLAUDE_DOCS = "https://docs.claude.com/claude-code";
const CLAUDE_CONSOLE = "https://console.anthropic.com/settings/usage";
const CLAUDE_GH_ISSUES = "https://github.com/anthropics/claude-code/issues";
const CLAUDE_GH_REPO = "https://github.com/anthropics/claude-code";

/** Shown when the user types a REPL-only slash (e.g. `/compact`). The bridge runs `claude -p` one-shot — no interactive REPL slashes. */
const MSG_NO_REPL_SLASH =
  "The bridge runs one-shot prompts — REPL-style slashes aren't supported here. Run `claude` in a terminal for the live REPL.";

const GROUP_ORDER = [
  "Context",
  "Model",
  "Customize",
  "Slash Commands",
  "Settings",
  "Support",
] as const;
type Group = (typeof GROUP_ORDER)[number];

interface MenuAction {
  id: string;
  label: string;
  group: Group;
  hint?: string;
  disabled?: boolean;
  /** Tooltip shown on disabled rows — surfaces "why" instead of just dimming. */
  disabledReason?: string;
  run: () => void | Promise<void>;
}

export function SlashActionsPalette({
  open,
  onOpenChange,
  repo,
  query,
  onPick,
  onAttach,
  onMention,
  onClearConversation,
  onRewind,
  onChangeModel,
  onRestartSession,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** App folder name (`bridge.json`). Drives the slash list endpoint. */
  repo: string;
  /** Text after the leading `/`. Driven by the composer's draft. */
  query: string;
  /** Insert text at the caret (e.g. `/clear `). */
  onPick: (text: string) => void;
  /** Optional composer hooks — when omitted the corresponding action is rendered disabled with a tooltip. */
  onAttach?: () => void;
  onMention?: () => void;
  onClearConversation?: () => void;
  onRewind?: () => void;
  onChangeModel?: () => void;
  onRestartSession?: () => void;
}) {
  const navigate = useNavigate();
  const toast = useToast();
  const theme = useTheme();
  const { data, isLoading } = useRepoSlashCommands(open ? repo : undefined);
  const [cursor, setCursor] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const close = useCallback(() => onOpenChange(false), [onOpenChange]);

  const externalOpen = useCallback(
    (url: string) => {
      window.open(url, "_blank", "noopener");
      close();
    },
    [close],
  );

  const navTo = useCallback(
    (path: string) => {
      navigate(path);
      close();
    },
    [navigate, close],
  );

  const noopReplSlash = useCallback(() => {
    toast.info("REPL-only slash", MSG_NO_REPL_SLASH);
    close();
  }, [toast, close]);

  // Built-in slug router — duplicates main's `runBuiltinSlug` adapted
  // to the SPA's degraded surface (no auth/logout, no `/sessions`
  // editor; `/init` and `/memory` still defer to the terminal REPL).
  const runBuiltinSlug = useCallback(
    (slug: string) => {
      switch (slug) {
        case "clear":
          if (onClearConversation) {
            onClearConversation();
            close();
          } else {
            toast.info("clear unavailable", "this surface doesn't host a conversation");
            close();
          }
          return;
        case "rewind":
          if (onRewind) {
            onRewind();
            close();
          } else {
            noopReplSlash();
          }
          return;
        case "help":
          externalOpen(CLAUDE_DOCS);
          return;
        case "cost":
        case "usage":
          navTo("/usage");
          return;
        case "model":
          if (onChangeModel) {
            onChangeModel();
            close();
          } else {
            toast.info("model picker", "Use the Mode menu (left of Send) to pick model & effort.");
            close();
          }
          return;
        case "init":
          toast.info(
            "REPL-only",
            "Run `claude` in a terminal and use `/init` there to scaffold CLAUDE.md.",
          );
          close();
          return;
        case "resume":
          toast.info(
            "already resumed",
            "This chat continues a session — switch threads from the sidebar or open one from /sessions.",
          );
          close();
          return;
        case "agents":
          navTo("/apps");
          return;
        case "permissions":
        case "config":
          navTo("/settings");
          return;
        case "hooks":
          externalOpen(`${CLAUDE_DOCS}/hooks`);
          return;
        case "mcp":
          externalOpen(`${CLAUDE_DOCS}/mcp`);
          return;
        case "memory":
          toast.info(
            "REPL-only",
            "Project memory edits use `/memory` inside a `claude` REPL session — see docs.",
          );
          externalOpen(`${CLAUDE_DOCS}/memory`);
          return;
        case "bug":
          externalOpen(CLAUDE_GH_ISSUES);
          return;
        default:
          // Unknown slug — fall back to inserting it as text into the
          // composer; the user may have a project-defined command we
          // didn't list (or a typo we shouldn't swallow).
          onPick(`/${slug} `);
          close();
      }
    },
    [
      onClearConversation,
      onRewind,
      onChangeModel,
      onPick,
      close,
      toast,
      externalOpen,
      navTo,
      noopReplSlash,
    ],
  );

  // Theme cycle — system → light → dark → system.
  const cycleTheme = useCallback(() => {
    const next =
      theme.pref === "system" ? "light" : theme.pref === "light" ? "dark" : "system";
    theme.setPref(next);
    toast.info("theme", `now ${next}`);
    close();
  }, [theme, toast, close]);

  // Assemble the static action set. These mirror the Claude Desktop
  // tabs (Context / Model / Customize / Settings / Support); items
  // without a wired callback render disabled with a hover hint
  // explaining why.
  const staticActions: MenuAction[] = useMemo(
    () => [
      // Context
      {
        id: "attach",
        label: "Attach file…",
        hint: "max 25 MB",
        group: "Context",
        disabled: !onAttach,
        disabledReason: "Open the slash menu from the message composer to attach files",
        run: () => {
          onAttach?.();
          close();
        },
      },
      {
        id: "mention",
        label: "Mention file from this project…",
        group: "Context",
        disabled: !onMention,
        disabledReason: "Open from the composer (then type @)",
        run: () => {
          onMention?.();
          close();
        },
      },
      {
        id: "clear",
        label: "Clear conversation",
        group: "Context",
        disabled: !onClearConversation,
        disabledReason: "No conversation on this surface",
        run: () => {
          onClearConversation?.();
          close();
        },
      },
      {
        id: "rewind",
        label: "Rewind to a previous turn…",
        group: "Context",
        disabled: !onRewind,
        disabledReason: "Rewind requires a live session",
        run: () => {
          onRewind?.();
          close();
        },
      },
      {
        id: "restart-session",
        label: "Restart session",
        group: "Context",
        disabled: !onRestartSession,
        disabledReason: "No session host wired here",
        run: () => {
          onRestartSession?.();
          close();
        },
      },

      // Model
      {
        id: "switch-model",
        label: "Switch model…",
        hint: onChangeModel ? "Default (recommended)" : "Use the Mode picker",
        group: "Model",
        run: () => {
          if (onChangeModel) onChangeModel();
          else toast.info("model picker", "Use the Mode menu to the left of Send.");
          close();
        },
      },
      {
        id: "account-usage",
        label: "Account & usage…",
        group: "Model",
        run: () => externalOpen(CLAUDE_CONSOLE),
      },

      // Customize
      {
        id: "agents",
        label: "Agents",
        group: "Customize",
        run: () => navTo("/apps"),
      },
      {
        id: "hooks",
        label: "Hooks",
        group: "Customize",
        run: () => externalOpen(`${CLAUDE_DOCS}/hooks`),
      },
      {
        id: "permissions",
        label: "Permissions",
        group: "Customize",
        run: () => navTo("/settings"),
      },
      {
        id: "mcp",
        label: "MCP servers",
        group: "Customize",
        run: () => externalOpen(`${CLAUDE_DOCS}/mcp`),
      },
      {
        id: "open-cli",
        label: "Open Claude in Terminal",
        hint: "copies `claude`",
        group: "Customize",
        run: async () => {
          try {
            await navigator.clipboard.writeText("claude");
            toast.info("copied", "paste `claude` in your terminal");
          } catch {
            toast.error("clipboard blocked");
          }
          close();
        },
      },

      // Settings
      {
        id: "open-settings",
        label: "Open Settings",
        group: "Settings",
        run: () => navTo("/settings"),
      },
      {
        id: "tasks",
        label: "Tasks",
        group: "Settings",
        run: () => navTo("/tasks"),
      },
      {
        id: "sessions",
        label: "Sessions",
        group: "Settings",
        run: () => navTo("/sessions"),
      },
      {
        id: "theme",
        label: "Theme",
        hint: theme.pref,
        group: "Settings",
        run: cycleTheme,
      },
      {
        id: "sign-out",
        label: "Sign out",
        group: "Settings",
        // Auth flow not yet ported in the Go bridge / SPA — render
        // disabled rather than silently dropping the click.
        disabled: true,
        disabledReason: "Auth flow not yet ported",
        run: () => {},
      },

      // Support
      {
        id: "help-docs",
        label: "View help docs",
        group: "Support",
        run: () => externalOpen(CLAUDE_DOCS),
      },
      {
        id: "report",
        label: "File an issue",
        group: "Support",
        run: () => externalOpen(CLAUDE_GH_ISSUES),
      },
      {
        id: "github",
        label: "GitHub repo",
        group: "Support",
        run: () => externalOpen(CLAUDE_GH_REPO),
      },
      {
        id: "version",
        label: "Version",
        hint: `v${VERSION}`,
        group: "Support",
        disabled: true,
        run: () => {},
      },
    ],
    [
      onAttach,
      onMention,
      onClearConversation,
      onRewind,
      onRestartSession,
      onChangeModel,
      theme.pref,
      cycleTheme,
      navTo,
      externalOpen,
      close,
      toast,
    ],
  );

  // Slash commands fetched from `/api/repos/<repo>/slash-commands`,
  // mapped to MenuActions. Built-ins route through `runBuiltinSlug`;
  // user/project commands insert as text (the user's prompt drives
  // them).
  const slashActions: MenuAction[] = useMemo(() => {
    if (!repo) return [];
    if (isLoading && !data) {
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
    const items: SlashCommandsItemDto[] = data?.items ?? [];
    return items.map((item): MenuAction => {
      const hintParts: string[] = [];
      if (item.description?.trim()) {
        const t = item.description.trim();
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
            onPick(`/${item.slug} `);
            close();
            return;
          }
          runBuiltinSlug(item.slug);
        },
      };
    });
  }, [repo, isLoading, data, onPick, close, runBuiltinSlug]);

  const allActions = useMemo(
    () => [...staticActions, ...slashActions],
    [staticActions, slashActions],
  );

  // Apply the composer's `query` (text after `/`) as the filter — same
  // matching behaviour as the original list so typing `/cle` narrows
  // to clear-conversation et al.
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return allActions;
    return allActions.filter(
      (a) =>
        a.id.toLowerCase().includes(q) ||
        a.label.toLowerCase().includes(q) ||
        a.group.toLowerCase().includes(q) ||
        (a.hint?.toLowerCase().includes(q) ?? false),
    );
  }, [allActions, query]);

  const grouped = useMemo(() => {
    const map = new Map<Group, MenuAction[]>();
    for (const a of filtered) {
      if (!map.has(a.group)) map.set(a.group, []);
      map.get(a.group)!.push(a);
    }
    return GROUP_ORDER.filter((g) => map.has(g)).map((g) => ({
      name: g,
      items: map.get(g)!,
    }));
  }, [filtered]);

  // Keep the cursor on the same id when the filter changes if it's
  // still in the list, otherwise snap to the first non-disabled row.
  const effectiveCursor = useMemo(() => {
    if (!open || filtered.length === 0) return null;
    if (cursor && filtered.some((a) => a.id === cursor && !a.disabled)) {
      return cursor;
    }
    return filtered.find((a) => !a.disabled)?.id ?? null;
  }, [open, filtered, cursor]);

  // Keyboard handling — duplicates the original's ↑↓↵Esc plus Tab; the
  // composer hands keyboard control over while `slashOpen` is true.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        close();
        return;
      }
      const usableIds = filtered.filter((a) => !a.disabled).map((a) => a.id);
      if (usableIds.length === 0) return;
      const i = effectiveCursor ? usableIds.indexOf(effectiveCursor) : -1;
      if (e.key === "ArrowDown") {
        e.preventDefault();
        const n = i < 0 ? 0 : (i + 1) % usableIds.length;
        setCursor(usableIds[n]);
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        const n = i < 0 ? usableIds.length - 1 : (i - 1 + usableIds.length) % usableIds.length;
        setCursor(usableIds[n]);
      } else if (e.key === "Enter" || e.key === "Tab") {
        const pick = filtered.find((a) => a.id === effectiveCursor && !a.disabled);
        if (pick) {
          e.preventDefault();
          void pick.run();
        }
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, filtered, effectiveCursor, close]);

  // Click-outside close — same contract as before.
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      const c = containerRef.current;
      if (!c) return;
      if (!c.contains(e.target as Node)) close();
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open, close]);

  // Scroll the highlighted row into view when the cursor moves.
  useEffect(() => {
    if (!open || !effectiveCursor) return;
    const el = containerRef.current?.querySelector<HTMLElement>(
      `[data-slash-id="${CSS.escape(effectiveCursor)}"]`,
    );
    el?.scrollIntoView({ block: "nearest" });
  }, [effectiveCursor, open]);

  if (!open) return null;

  return (
    <div
      ref={containerRef}
      className="absolute bottom-full mb-2 left-0 right-0 max-w-md bg-card border border-border rounded-md shadow-2xl z-40 overflow-hidden animate-fade-up flex flex-col"
      role="listbox"
      aria-label="Slash actions"
    >
      <div className="px-3 py-1.5 border-b border-border flex items-center gap-2 text-micro uppercase tracking-wideish text-muted-foreground shrink-0">
        <Terminal size={11} />
        Actions
        <span className="ml-auto font-mono normal-case text-muted-foreground">
          /{query}
        </span>
      </div>

      <div className="overflow-y-auto max-h-72 py-1 flex-1 min-h-0">
        {grouped.length === 0 ? (
          <div className="px-3 py-6 text-center text-xs text-muted-foreground italic">
            {isLoading ? "Loading…" : "No actions match"}
          </div>
        ) : (
          grouped.map((g, gi) => (
            <div key={g.name}>
              {gi > 0 && <div className="mx-3 my-1 h-px bg-border/60" />}
              <div className="px-3 pt-1 pb-0.5 text-[10px] uppercase tracking-wideish font-medium text-muted-foreground">
                {g.name}
              </div>
              {g.items.map((it) => {
                const hi = effectiveCursor === it.id;
                return (
                  <button
                    key={it.id}
                    type="button"
                    role="option"
                    aria-selected={hi}
                    data-slash-id={it.id}
                    disabled={it.disabled}
                    title={it.disabled ? it.disabledReason : undefined}
                    onMouseEnter={() => !it.disabled && setCursor(it.id)}
                    onMouseDown={(e) => {
                      if (it.disabled) return;
                      // mouseDown so we beat the textarea's blur.
                      e.preventDefault();
                      void it.run();
                    }}
                    className={cn(
                      "w-full flex items-center gap-2 px-3 py-1.5 text-left text-xs transition-colors",
                      "disabled:opacity-40 disabled:cursor-not-allowed",
                      !it.disabled && hi && "bg-secondary",
                      !it.disabled && !hi && "hover:bg-secondary/60",
                    )}
                  >
                    <span className="flex-1 min-w-0 truncate text-foreground">
                      {it.label}
                    </span>
                    {it.hint && (
                      <span className="shrink-0 text-[10px] text-muted-foreground/80 max-w-[45%] truncate">
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

      <div className="border-t border-border bg-secondary px-3 py-1 flex items-center gap-2 text-[10px] text-muted-foreground/80 shrink-0 justify-between">
        <span className="truncate min-w-0">
          ↑↓ move · ↵/Tab pick · Esc close
        </span>
        <span className="tabular-nums shrink-0 font-mono">v{VERSION}</span>
      </div>
    </div>
  );
}
