"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { SessionSummary, Task } from "@/libs/client/types";
import {
  Search,
  Plus,
  ListTodo,
  Terminal,
  Crown,
  Sparkles,
} from "lucide-react";

type Item =
  | { kind: "action"; id: string; label: string; hint?: string; icon: React.ComponentType<{ size?: number; className?: string }>; run: () => void }
  | { kind: "task"; task: Task; run: () => void }
  | { kind: "session"; session: SessionSummary; run: () => void };

interface PaletteProps {
  tasks: Task[];
  sessions: SessionSummary[];
  onClose: () => void;
  onOpenTask: (id: string) => void;
  onCreateTask: () => void;
  onNavigate: (path: string) => void;
  onSelectSession: (s: SessionSummary) => void;
}

// Outer mounts the inner only while the palette is open. That makes
// every "open" a fresh mount, so search query + cursor state reset
// for free without a `useEffect` that calls `setQ`/`setCursor`. Keeps
// the React 19 `set-state-in-effect` rule happy.
export function CommandPalette({ open, ...rest }: PaletteProps & { open: boolean }) {
  if (!open) return null;
  return <CommandPaletteInner {...rest} />;
}

function CommandPaletteInner({
  tasks,
  sessions,
  onClose,
  onOpenTask,
  onCreateTask,
  onNavigate,
  onSelectSession,
}: PaletteProps) {
  const [q, setQ] = useState("");
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  // Focus the input on mount. setTimeout(0) lets the dialog finish
  // its enter animation / commit before we steal focus.
  useEffect(() => {
    const id = setTimeout(() => inputRef.current?.focus(), 0);
    return () => clearTimeout(id);
  }, []);

  const items: Item[] = useMemo(() => {
    const actions: Item[] = [
      { kind: "action", id: "new", label: "Create new task", icon: Plus, hint: "⌘N",
        run: () => { onCreateTask(); onClose(); } },
      { kind: "action", id: "board", label: "Go to Tasks", icon: ListTodo,
        run: () => { onNavigate("/"); onClose(); } },
      { kind: "action", id: "sessions", label: "Go to Sessions", icon: Terminal,
        run: () => { onNavigate("/sessions"); onClose(); } },
    ];

    const taskItems: Item[] = tasks.map((t) => ({
      kind: "task", task: t,
      run: () => { onOpenTask(t.id); onClose(); },
    }));

    const sessionItems: Item[] = sessions.slice(0, 30).map((s) => ({
      kind: "session", session: s,
      run: () => { onSelectSession(s); onClose(); },
    }));

    const all: Item[] = [...actions, ...taskItems, ...sessionItems];
    const needle = q.trim().toLowerCase();
    if (!needle) return all;
    return all.filter((it) => {
      if (it.kind === "action") return it.label.toLowerCase().includes(needle);
      if (it.kind === "task")   return it.task.title.toLowerCase().includes(needle) || it.task.id.includes(needle);
      return (
        it.session.sessionId.includes(needle) ||
        it.session.preview.toLowerCase().includes(needle) ||
        it.session.repo.toLowerCase().includes(needle)
      );
    });
  }, [q, tasks, sessions, onCreateTask, onNavigate, onOpenTask, onSelectSession, onClose]);

  // Clamp at render-time instead of via an effect that calls
  // setCursor — `cursor` may temporarily exceed `items.length` after
  // the user filters down, but every event handler reads `effCursor`
  // and we never index out of bounds.
  const effCursor = items.length === 0 ? 0 : Math.min(cursor, items.length - 1);

  const ROLE_ICON: Record<string, React.ComponentType<{ size?: number; className?: string }>> = {
    coordinator: Crown,
  };

  const renderItem = (it: Item, idx: number) => {
    const active = idx === effCursor;
    const base = `flex items-center gap-3 px-3 py-2 cursor-pointer transition-colors ${
      active ? "bg-primary/15" : "hover:bg-accent"
    }`;

    if (it.kind === "action") {
      const Icon = it.icon;
      return (
        <div key={`a-${it.id}`} className={base} onMouseEnter={() => setCursor(idx)} onClick={it.run}>
          <Icon size={14} className="text-muted-foreground shrink-0" />
          <span className="flex-1 text-sm">{it.label}</span>
          {it.hint && <kbd className="text-[10px] text-fg-dim font-mono">{it.hint}</kbd>}
        </div>
      );
    }

    if (it.kind === "task") {
      const t = it.task;
      return (
        <div key={`t-${t.id}`} className={base} onMouseEnter={() => setCursor(idx)} onClick={it.run}>
          <ListTodo size={14} className="text-primary shrink-0" />
          <div className="flex-1 min-w-0">
            <div className="text-sm truncate">{t.title}</div>
            <div className="text-[10px] text-fg-dim font-mono">{t.id} · {t.section}</div>
          </div>
        </div>
      );
    }

    const s = it.session;
    const RoleIcon = s.link ? (ROLE_ICON[s.link.role] ?? Sparkles) : Terminal;
    return (
      <div key={`s-${s.sessionId}`} className={base} onMouseEnter={() => setCursor(idx)} onClick={it.run}>
        <RoleIcon size={14} className="text-muted-foreground shrink-0" />
        <div className="flex-1 min-w-0">
          <div className="text-sm truncate">
            {s.preview || <span className="text-fg-dim italic">(no preview)</span>}
          </div>
          <div className="text-[10px] text-fg-dim font-mono truncate">
            {s.sessionId.slice(0, 8)}… @ {s.repo}
            {s.link ? ` · ${s.link.role} ↔ ${s.link.taskId}` : " · orphan"}
          </div>
        </div>
      </div>
    );
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") { e.preventDefault(); setCursor(Math.min(items.length - 1, effCursor + 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setCursor(Math.max(0, effCursor - 1)); }
    else if (e.key === "Enter") { e.preventDefault(); items[effCursor]?.run(); }
    else if (e.key === "Escape") { e.preventDefault(); onClose(); }
  };

  const groupedCount = {
    actions: items.filter((i) => i.kind === "action").length,
    tasks:   items.filter((i) => i.kind === "task").length,
    sessions:items.filter((i) => i.kind === "session").length,
  };

  return (
    <div className="fixed inset-0 z-60 flex items-start justify-center pt-24 px-4 pointer-events-none">
      <div
        onClick={onClose}
        className="fixed inset-0 bg-black/50 backdrop-blur-sm animate-slide-in pointer-events-auto"
      />
      <div className="relative w-full max-w-xl bg-card border border-border rounded-xl shadow-2xl overflow-hidden animate-slide-in pointer-events-auto">
        <div className="flex items-center gap-2 px-3 py-2 border-b border-border">
          <Search size={14} className="text-muted-foreground shrink-0" />
          <input
            ref={inputRef}
            value={q}
            onChange={(e) => { setQ(e.target.value); setCursor(0); }}
            onKeyDown={onKeyDown}
            placeholder="Search tasks, sessions, or actions…"
            className="flex-1 bg-transparent text-sm focus:outline-none"
          />
          <kbd className="text-[10px] text-fg-dim font-mono">Esc</kbd>
        </div>
        <div className="max-h-96 overflow-y-auto">
          {items.length === 0 ? (
            <div className="p-6 text-center text-xs text-fg-dim">No matches</div>
          ) : (
            items.map((it, i) => renderItem(it, i))
          )}
        </div>
        <div className="px-3 py-1.5 border-t border-border bg-secondary text-[10px] text-fg-dim flex gap-3">
          <span>{groupedCount.actions} actions</span>
          <span>{groupedCount.tasks} tasks</span>
          <span>{groupedCount.sessions} sessions</span>
          <span className="ml-auto">↑↓ move · ↵ run · Esc close</span>
        </div>
      </div>
    </div>
  );
}
