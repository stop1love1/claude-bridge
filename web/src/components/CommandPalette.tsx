import { useEffect, useMemo, useRef, useState } from "react";
import {
  Search,
  Plus,
  ListTodo,
  Terminal,
  Crown,
  Sparkles,
  Layers,
  BarChart3,
  Settings as SettingsIcon,
} from "lucide-react";
import { useNavigate } from "react-router-dom";
import { useApps, useSessions, useTasks } from "@/api/queries";
import type { App, SessionSummary, Task } from "@/api/types";
import { cn } from "@/lib/cn";

// `LucideIcon` renders ForwardRef components — typing these slots as
// `ComponentType<any>` keeps the call sites readable without fighting
// the ref-types under strict mode.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type IconComponent = React.ComponentType<any>;

type Item =
  | {
      kind: "action";
      id: string;
      label: string;
      hint?: string;
      icon: IconComponent;
      run: () => void;
    }
  | { kind: "task"; task: Task; run: () => void }
  | { kind: "session"; session: SessionSummary; run: () => void }
  | { kind: "app"; app: App; run: () => void };

const ROLE_ICON: Record<string, IconComponent> = {
  coordinator: Crown,
};

/**
 * Cmd+K / Ctrl+K palette body. Doesn't own the open-state — the host
 * (CommandPaletteHost) does, so we can fully unmount on close and get
 * fresh search/cursor state on every open.
 */
function CommandPaletteInner({
  tasks,
  sessions,
  apps,
  onClose,
}: {
  tasks: Task[];
  sessions: SessionSummary[];
  apps: App[];
  onClose: () => void;
}) {
  const navigate = useNavigate();
  const [q, setQ] = useState("");
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const id = setTimeout(() => inputRef.current?.focus(), 0);
    return () => clearTimeout(id);
  }, []);

  const items: Item[] = useMemo(() => {
    const goto = (path: string) => () => {
      navigate(path);
      onClose();
    };
    const actions: Item[] = [
      {
        kind: "action",
        id: "new",
        label: "Create new task",
        icon: Plus,
        run: goto("/tasks?new=1"),
      },
      {
        kind: "action",
        id: "tasks",
        label: "Open Tasks",
        icon: ListTodo,
        run: goto("/tasks"),
      },
      {
        kind: "action",
        id: "sessions",
        label: "Open Sessions",
        icon: Terminal,
        run: goto("/sessions"),
      },
      {
        kind: "action",
        id: "apps",
        label: "Open Apps",
        icon: Layers,
        run: goto("/apps"),
      },
      {
        kind: "action",
        id: "usage",
        label: "Open Usage",
        icon: BarChart3,
        run: goto("/usage"),
      },
      {
        kind: "action",
        id: "settings",
        label: "Open Settings",
        icon: SettingsIcon,
        run: goto("/settings"),
      },
    ];

    const taskItems: Item[] = tasks.map((t) => ({
      kind: "task",
      task: t,
      run: () => {
        navigate(`/tasks/${encodeURIComponent(t.id)}`);
        onClose();
      },
    }));

    const sessionItems: Item[] = sessions.slice(0, 30).map((s) => ({
      kind: "session",
      session: s,
      run: () => {
        navigate(`/sessions?id=${encodeURIComponent(s.sessionId)}`);
        onClose();
      },
    }));

    const appItems: Item[] = apps.map((a) => ({
      kind: "app",
      app: a,
      run: () => {
        navigate(`/apps?name=${encodeURIComponent(a.name)}`);
        onClose();
      },
    }));

    const all: Item[] = [
      ...actions,
      ...taskItems,
      ...sessionItems,
      ...appItems,
    ];
    const needle = q.trim().toLowerCase();
    if (!needle) return all;
    return all.filter((it) => {
      if (it.kind === "action") return it.label.toLowerCase().includes(needle);
      if (it.kind === "task")
        return (
          it.task.title.toLowerCase().includes(needle) ||
          it.task.id.includes(needle)
        );
      if (it.kind === "session")
        return (
          it.session.sessionId.includes(needle) ||
          it.session.preview.toLowerCase().includes(needle) ||
          it.session.repo.toLowerCase().includes(needle)
        );
      return (
        it.app.name.toLowerCase().includes(needle) ||
        (it.app.description ?? "").toLowerCase().includes(needle)
      );
    });
  }, [q, tasks, sessions, apps, navigate, onClose]);

  const effCursor = items.length === 0 ? 0 : Math.min(cursor, items.length - 1);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setCursor(Math.min(items.length - 1, effCursor + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setCursor(Math.max(0, effCursor - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      items[effCursor]?.run();
    } else if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    }
  };

  const renderItem = (it: Item, idx: number) => {
    const active = idx === effCursor;
    const base = cn(
      "flex items-center gap-3 px-3 py-2 cursor-pointer transition-colors",
      active ? "bg-primary/15" : "hover:bg-secondary",
    );
    const optionProps = {
      role: "option" as const,
      "aria-selected": active,
      onMouseEnter: () => setCursor(idx),
    };

    if (it.kind === "action") {
      const Icon = it.icon;
      return (
        <div key={`a-${it.id}`} className={base} {...optionProps} onClick={it.run}>
          <Icon size={14} className="text-muted-foreground shrink-0" />
          <span className="flex-1 text-sm">{it.label}</span>
          {it.hint && (
            <kbd className="text-[10px] text-muted-foreground font-mono">{it.hint}</kbd>
          )}
        </div>
      );
    }

    if (it.kind === "task") {
      const t = it.task;
      return (
        <div key={`t-${t.id}`} className={base} {...optionProps} onClick={it.run}>
          <ListTodo size={14} className="text-primary shrink-0" />
          <div className="flex-1 min-w-0">
            <div className="text-sm truncate">{t.title}</div>
            <div className="text-[10px] text-muted-foreground font-mono">
              {t.id} · {t.section}
            </div>
          </div>
        </div>
      );
    }

    if (it.kind === "session") {
      const s = it.session;
      const RoleIcon = s.link ? ROLE_ICON[s.link.role] ?? Sparkles : Terminal;
      return (
        <div
          key={`s-${s.sessionId}`}
          className={base}
          {...optionProps}
          onClick={it.run}
        >
          <RoleIcon size={14} className="text-muted-foreground shrink-0" />
          <div className="flex-1 min-w-0">
            <div className="text-sm truncate">
              {s.preview || (
                <span className="text-muted-foreground italic">(no preview)</span>
              )}
            </div>
            <div className="text-[10px] text-muted-foreground font-mono truncate">
              {s.sessionId.slice(0, 8)}… @ {s.repo}
              {s.link ? ` · ${s.link.role} ↔ ${s.link.taskId}` : " · orphan"}
            </div>
          </div>
        </div>
      );
    }

    const a = it.app;
    return (
      <div key={`app-${a.name}`} className={base} {...optionProps} onClick={it.run}>
        <Layers size={14} className="text-info shrink-0" />
        <div className="flex-1 min-w-0">
          <div className="text-sm truncate">{a.name}</div>
          <div className="text-[10px] text-muted-foreground font-mono truncate">
            {a.path}
          </div>
        </div>
      </div>
    );
  };

  const groupedCount = {
    actions: items.filter((i) => i.kind === "action").length,
    tasks: items.filter((i) => i.kind === "task").length,
    sessions: items.filter((i) => i.kind === "session").length,
    apps: items.filter((i) => i.kind === "app").length,
  };

  return (
    <div
      className="fixed inset-0 z-[60] flex items-start justify-center pt-24 px-4 pointer-events-none"
      role="dialog"
      aria-modal="true"
      aria-label="Command palette"
    >
      <div
        onClick={onClose}
        className="fixed inset-0 bg-black/60 backdrop-blur-sm pointer-events-auto"
        aria-hidden="true"
      />
      <div className="relative w-full max-w-xl bg-card border border-border rounded-md shadow-2xl overflow-hidden animate-fade-up pointer-events-auto">
        <div className="flex items-center gap-2 px-3 py-2 border-b border-border">
          <Search size={14} className="text-muted-foreground shrink-0" aria-hidden="true" />
          <input
            ref={inputRef}
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              setCursor(0);
            }}
            onKeyDown={onKeyDown}
            placeholder="Search tasks, sessions, apps, or actions…"
            className="flex-1 bg-transparent text-sm focus:outline-none"
            role="combobox"
            aria-expanded="true"
            aria-controls="cmdk-listbox"
            aria-autocomplete="list"
            aria-label="Search"
          />
          <kbd className="text-[10px] text-muted-foreground font-mono">Esc</kbd>
        </div>
        <div
          id="cmdk-listbox"
          role="listbox"
          aria-label="Command results"
          className="max-h-96 overflow-y-auto"
        >
          {items.length === 0 ? (
            <div className="p-6 text-center text-xs text-muted-foreground">No matches</div>
          ) : (
            items.map((it, i) => renderItem(it, i))
          )}
        </div>
        <div className="px-3 py-1.5 border-t border-border bg-secondary text-[10px] text-muted-foreground flex gap-3">
          <span>{groupedCount.actions} actions</span>
          <span>{groupedCount.tasks} tasks</span>
          <span>{groupedCount.sessions} sessions</span>
          <span>{groupedCount.apps} apps</span>
          <span className="ml-auto">↑↓ move · ↵ run · Esc close</span>
        </div>
      </div>
    </div>
  );
}

/**
 * Mountable host. Owns the global Cmd+K / Ctrl+K listener and the
 * open-state. Drop one instance into App.tsx and the palette is
 * available everywhere.
 *
 * Buttons that want to open the palette dispatch a `bridge:open-palette`
 * CustomEvent on `window` instead of poking ref handles — keeps the
 * host self-contained and avoids prop-drilling an opener through the
 * router.
 */
export const PALETTE_OPEN_EVENT = "bridge:open-palette";

/** Imperative opener for buttons / hotkeys other than Cmd+K. */
export function openCommandPalette(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(PALETTE_OPEN_EVENT));
}

export function CommandPaletteHost() {
  const [open, setOpen] = useState(false);
  const tasksQ = useTasks();
  const sessionsQ = useSessions();
  const appsQ = useApps();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((v) => !v);
      }
    };
    const onOpen = () => setOpen(true);
    window.addEventListener("keydown", onKey);
    window.addEventListener(PALETTE_OPEN_EVENT, onOpen);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener(PALETTE_OPEN_EVENT, onOpen);
    };
  }, []);

  if (!open) return null;
  return (
    <CommandPaletteInner
      tasks={tasksQ.data ?? []}
      sessions={sessionsQ.data ?? []}
      apps={appsQ.data?.apps ?? []}
      onClose={() => setOpen(false)}
    />
  );
}

/** Standalone form — caller controls open/close (used in tests / story). */
export function CommandPalette({
  open,
  onClose,
  tasks,
  sessions,
  apps,
}: {
  open: boolean;
  onClose: () => void;
  tasks: Task[];
  sessions: SessionSummary[];
  apps: App[];
}) {
  if (!open) return null;
  return (
    <CommandPaletteInner
      tasks={tasks}
      sessions={sessions}
      apps={apps}
      onClose={onClose}
    />
  );
}
