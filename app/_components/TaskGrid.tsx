"use client";

import { useMemo, useState } from "react";
import type { Meta, Task, TaskSection } from "@/lib/client/types";
import { SECTION_ORDER, SECTION_LABEL } from "@/lib/client/types";
import {
  Crown, Sparkles, Plus, Inbox, Trash2, LayoutGrid, Columns, Check,
} from "lucide-react";
import { relativeTime } from "@/lib/client/time";
import { STATUS_PILL, type DerivedStatus } from "@/lib/client/runStatus";
import { useLocalStorage } from "@/lib/client/useLocalStorage";
import { EmptyState } from "./ui/empty-state";
import { Button } from "./ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./ui/select";

const ROLE_ICON: Record<string, React.ComponentType<{ size?: number; className?: string }>> = {
  coordinator: Crown,
};
const ROLE_COLOR: Record<string, string> = {
  coordinator: "text-warning",
};

const LAYOUT_KEY = "bridge.tasks.layout";
type Layout = "grid" | "kanban";
const loadLayout = (raw: string | null): Layout =>
  raw === "kanban" ? "kanban" : "grid";
const dumpLayout = (v: Layout) => v;

function roleIcon(role: string) { return ROLE_ICON[role] ?? Sparkles; }
function roleColor(role: string) { return ROLE_COLOR[role] ?? "text-muted-foreground"; }

function deriveStatus(task: Task, meta: Meta | undefined): DerivedStatus {
  if (task.checked) return "completed";
  if (!meta) return "spawning";
  const runs = meta.runs ?? [];
  const createdMs = meta.createdAt ? new Date(meta.createdAt).getTime() : 0;
  const fresh = createdMs > 0 && Date.now() - createdMs < 20_000;
  if (runs.length === 0) return fresh ? "spawning" : "idle";
  if (runs.some((r) => r.status === "running")) return "running";
  if (runs.some((r) => r.status === "failed")) return "failed";
  if (runs.some((r) => r.status === "done")) return "done";
  return "idle";
}

function GridCard({
  task,
  meta,
  active,
  selected,
  draggable,
  onOpen,
  onDelete,
  onToggleSelect,
  onDragStart,
  onDragEnd,
}: {
  task: Task;
  meta: Meta | undefined;
  active: boolean;
  selected: boolean;
  draggable?: boolean;
  onOpen: () => void;
  onDelete: () => void;
  onToggleSelect: () => void;
  onDragStart?: (e: React.DragEvent<HTMLDivElement>) => void;
  onDragEnd?: (e: React.DragEvent<HTMLDivElement>) => void;
}) {
  const runs = meta?.runs ?? [];
  const roleSet = Array.from(new Set(runs.map((r) => r.role)));
  // The bridge itself runs the coordinator role; hide it from the
  // sibling-repo + agent count summaries so a task that only has the
  // coordinator running doesn't read as "1 agent" (zero have been
  // dispatched yet — the coordinator is the dispatcher).
  const childRuns = runs.filter((r) => r.role !== "coordinator");
  const repoSet = Array.from(new Set(childRuns.map((r) => r.repo)));
  const status = deriveStatus(task, meta);
  const pill = STATUS_PILL[status];
  const agentCount = childRuns.length;

  return (
    <div
      onClick={onOpen}
      draggable={draggable}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      className={`group relative rounded-lg border p-3 cursor-pointer transition-all bg-card ${
        draggable ? "active:cursor-grabbing" : ""
      } ${
        selected
          ? "border-primary/70 ring-1 ring-primary/40"
          : active
            ? "border-primary/60 shadow-[0_0_0_1px_rgb(106,168,255,0.3)]"
            : "border-border hover:border-border hover:bg-accent"
      } ${status === "running" ? "ring-1 ring-warning/30" : ""}`}
    >
      <div className="flex items-start gap-2">
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); onToggleSelect(); }}
          aria-pressed={selected}
          aria-label={selected ? `Deselect task ${task.id}` : `Select task ${task.id}`}
          className={`shrink-0 mt-0.5 h-4 w-4 rounded border flex items-center justify-center transition-colors ${
            selected
              ? "border-primary bg-primary text-primary-foreground"
              : "border-border bg-background opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
          }`}
        >
          {selected && <Check size={11} strokeWidth={3} />}
        </button>
        <h3
          className={`flex-1 text-sm font-medium line-clamp-2 min-w-0 ${
            task.checked ? "line-through text-muted-foreground" : "text-foreground"
          }`}
        >
          {task.title}
        </h3>
        <span
          className={`shrink-0 inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[9px] font-semibold uppercase tracking-wide ${pill.cls}`}
        >
          {pill.pulse && (
            <span className="relative inline-flex h-1.5 w-1.5">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-current opacity-60" />
              <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-current" />
            </span>
          )}
          {pill.label}
        </span>
      </div>

      {(roleSet.length > 0 || repoSet.length > 0 || agentCount > 0) && (
        <div className="flex items-center gap-1.5 flex-wrap mt-2 ml-6">
          {roleSet.map((role) => {
            const Icon = roleIcon(role);
            const color = roleColor(role);
            return (
              <Icon key={role} size={12} className={`${color} shrink-0`} aria-label={role} />
            );
          })}
          {agentCount > 0 && (
            <span className="text-[10px] text-muted-foreground">
              {agentCount} {agentCount === 1 ? "agent" : "agents"}
            </span>
          )}
          {repoSet.map((r) => (
            <span
              key={r}
              className="text-[9px] font-mono font-semibold px-1 py-px rounded bg-primary/10 text-primary truncate max-w-[100px]"
              title={r}
            >
              {r}
            </span>
          ))}
        </div>
      )}

      <div className="mt-2 ml-6 flex items-center justify-between text-[10px] text-fg-dim">
        <span>{relativeTime(meta?.createdAt ?? `${task.date}T00:00:00Z`)}</span>
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); onDelete(); }}
          className="p-1 rounded text-fg-dim hover:text-destructive hover:bg-destructive/10 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-destructive"
          aria-label={`Delete task ${task.id}`}
          title="Delete task"
        >
          <Trash2 size={12} />
        </button>
      </div>
    </div>
  );
}

const SECTION_ACCENT: Record<TaskSection, string> = {
  TODO:    "border-fg-dim/40",
  DOING:   "border-warning/40",
  BLOCKED: "border-destructive/40",
  "DONE — not yet archived": "border-success/40",
};

// Per-section copy for empty Kanban columns. Generic "empty" reads the
// same in all four states; tailored hints make TODO and BLOCKED feel
// purposeful and tell the operator what dropping a card here means.
const SECTION_EMPTY: Record<TaskSection, { title: string; hint: string }> = {
  TODO:    { title: "Nothing queued",  hint: "Drag a card here, or quick-add above." },
  DOING:   { title: "Idle",            hint: "Drag a card here to mark it in-progress." },
  BLOCKED: { title: "Nothing blocked", hint: "Drag a card here when work can't proceed." },
  "DONE — not yet archived": {
    title: "Nothing shipped yet",
    hint: "Tick the checkbox on a card to land it here.",
  },
};

const DND_MIME = "application/x-bridge-task-id";

export function TaskGrid({
  tasks,
  metaByTask,
  activeTaskId,
  query,
  onOpenTask,
  onQuickAdd,
  onDeleteTask,
  onBulkDelete,
  onBulkMove,
  onMoveTask,
}: {
  tasks: Task[];
  metaByTask: Map<string, Meta>;
  activeTaskId: string | null;
  query: string;
  onOpenTask: (id: string) => void;
  onQuickAdd: (body: string) => void;
  onDeleteTask: (id: string) => void;
  onBulkDelete?: (ids: string[]) => Promise<void> | void;
  onBulkMove?: (ids: string[], section: TaskSection) => Promise<void> | void;
  onMoveTask?: (id: string, section: TaskSection) => Promise<void> | void;
}) {
  const [quick, setQuick] = useState("");
  // Layout pref hydrates through `useSyncExternalStore` (the
  // `useLocalStorage` hook), which gives us SSR safety without an
  // effect that calls `setLayout`.
  const [layout, setLayoutPersist] = useLocalStorage<Layout>(
    LAYOUT_KEY,
    loadLayout,
    "grid",
    dumpLayout,
  );
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkBusy, setBulkBusy] = useState(false);
  // Tracks which Kanban column is currently the drop target so we can
  // highlight it and which task is being dragged so we can dim it.
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dragOverSection, setDragOverSection] = useState<TaskSection | null>(null);

  const q = query.trim().toLowerCase();
  const filtered = useMemo(() => {
    if (!q) return tasks;
    return tasks.filter(
      (t) =>
        t.title.toLowerCase().includes(q) ||
        t.body.toLowerCase().includes(q) ||
        t.id.toLowerCase().includes(q),
    );
  }, [tasks, q]);

  const sorted = useMemo(
    () =>
      [...filtered].sort((a, b) => {
        if (a.date !== b.date) return a.date < b.date ? 1 : -1;
        return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
      }),
    [filtered],
  );

  // Drop selected ids that no longer exist (e.g. after a delete).
  // Done via the React-docs "previous-render snapshot" trick — when
  // `sorted` changes between renders, recompute the cleaned set
  // synchronously during render and call `setSelected` *only* if it
  // really shrank. React eats the render and re-runs without
  // cascading.
  const [prevSorted, setPrevSorted] = useState(sorted);
  if (sorted !== prevSorted) {
    setPrevSorted(sorted);
    const visible = new Set(sorted.map((t) => t.id));
    let changed = false;
    const next = new Set<string>();
    for (const id of selected) {
      if (visible.has(id)) next.add(id);
      else changed = true;
    }
    if (changed) setSelected(next);
  }

  const toggleSelect = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };
  const clearSelect = () => setSelected(new Set());
  const selectAllVisible = () => setSelected(new Set(sorted.map((t) => t.id)));

  const groups = useMemo(() => {
    const m = new Map<TaskSection, Task[]>();
    for (const s of SECTION_ORDER) m.set(s, []);
    for (const t of sorted) {
      const list = m.get(t.section) ?? m.get("TODO")!;
      list.push(t);
    }
    return m;
  }, [sorted]);

  const submitQuick = () => {
    const v = quick.trim();
    if (!v) return;
    onQuickAdd(v);
    setQuick("");
  };

  const handleCardDragStart = (id: string) => (e: React.DragEvent<HTMLDivElement>) => {
    e.dataTransfer.setData(DND_MIME, id);
    e.dataTransfer.effectAllowed = "move";
    setDraggingId(id);
  };
  const handleCardDragEnd = () => {
    setDraggingId(null);
    setDragOverSection(null);
  };

  const renderCard = (t: Task, opts?: { kanban?: boolean }) => {
    const isDragging = draggingId === t.id;
    const draggable = !!(opts?.kanban && onMoveTask);
    return (
      <div
        key={t.id}
        className={isDragging ? "opacity-40" : ""}
      >
        <GridCard
          task={t}
          meta={metaByTask.get(t.id)}
          active={activeTaskId === t.id}
          selected={selected.has(t.id)}
          draggable={draggable}
          onOpen={() => onOpenTask(t.id)}
          onDelete={() => onDeleteTask(t.id)}
          onToggleSelect={() => toggleSelect(t.id)}
          onDragStart={draggable ? handleCardDragStart(t.id) : undefined}
          onDragEnd={draggable ? handleCardDragEnd : undefined}
        />
      </div>
    );
  };

  const handleBulkMove = async (section: TaskSection) => {
    if (!onBulkMove || selected.size === 0) return;
    setBulkBusy(true);
    try {
      await onBulkMove(Array.from(selected), section);
      clearSelect();
    } finally {
      setBulkBusy(false);
    }
  };
  const handleBulkDelete = async () => {
    if (!onBulkDelete || selected.size === 0) return;
    setBulkBusy(true);
    try {
      await onBulkDelete(Array.from(selected));
      clearSelect();
    } finally {
      setBulkBusy(false);
    }
  };

  const allSelected = sorted.length > 0 && selected.size === sorted.length;

  return (
    <div className="flex-1 flex flex-col min-h-0 relative">
      <div className="shrink-0 px-4 pt-3 pb-2 flex items-center gap-2 border-b border-border bg-background">
        <Plus size={14} className="text-fg-dim shrink-0" />
        <input
          value={quick}
          onChange={(e) => setQuick(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              submitQuick();
            } else if (e.key === "Escape") {
              setQuick("");
            }
          }}
          placeholder="Quick add — press Enter"
          className="flex-1 bg-transparent text-xs placeholder:text-fg-dim focus:outline-none"
        />
        <div className="flex items-center gap-0.5 rounded-md border border-border bg-card p-0.5 shrink-0">
          <button
            type="button"
            onClick={() => setLayoutPersist("grid")}
            aria-pressed={layout === "grid"}
            title="Flat grid"
            className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10.5px] ${
              layout === "grid"
                ? "bg-accent text-foreground"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            <LayoutGrid size={11} />
            <span className="hidden sm:inline">Grid</span>
          </button>
          <button
            type="button"
            onClick={() => setLayoutPersist("kanban")}
            aria-pressed={layout === "kanban"}
            title="Kanban columns by section"
            className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10.5px] ${
              layout === "kanban"
                ? "bg-accent text-foreground"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            <Columns size={11} />
            <span className="hidden sm:inline">Kanban</span>
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto pb-16">
        {sorted.length === 0 ? (
          <div className="h-full flex items-center justify-center p-6">
            <EmptyState
              icon={Inbox}
              title={q ? "No matches" : "No tasks yet"}
              hint={q ? "Try a different search term." : "Press ⌘N or click New task to get started."}
              className="max-w-sm"
            />
          </div>
        ) : layout === "grid" ? (
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3 p-4">
            {sorted.map((t) => renderCard(t))}
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-3 p-4">
            {SECTION_ORDER.map((section) => {
              const list = groups.get(section) ?? [];
              const isDropTarget = dragOverSection === section;
              const empty = SECTION_EMPTY[section];
              const onDragOver = onMoveTask
                ? (e: React.DragEvent<HTMLDivElement>) => {
                    if (!e.dataTransfer.types.includes(DND_MIME)) return;
                    e.preventDefault();
                    e.dataTransfer.dropEffect = "move";
                    if (dragOverSection !== section) setDragOverSection(section);
                  }
                : undefined;
              const onDragLeave = onMoveTask
                ? (e: React.DragEvent<HTMLDivElement>) => {
                    // dragleave fires every time the cursor enters a child;
                    // only clear the hover when the cursor truly leaves
                    // the column wrapper.
                    if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
                    if (dragOverSection === section) setDragOverSection(null);
                  }
                : undefined;
              const onDrop = onMoveTask
                ? (e: React.DragEvent<HTMLDivElement>) => {
                    e.preventDefault();
                    const id = e.dataTransfer.getData(DND_MIME);
                    setDragOverSection(null);
                    setDraggingId(null);
                    if (!id) return;
                    const t = tasks.find((x) => x.id === id);
                    if (!t || t.section === section) return;
                    void onMoveTask(id, section);
                  }
                : undefined;
              return (
                <div
                  key={section}
                  onDragOver={onDragOver}
                  onDragLeave={onDragLeave}
                  onDrop={onDrop}
                  className={`flex flex-col rounded-lg border-2 ${
                    isDropTarget ? "border-primary bg-primary/10" : `${SECTION_ACCENT[section]} bg-secondary/30`
                  } min-h-[160px] transition-colors`}
                >
                  <div className="flex items-center justify-between px-3 py-2 border-b border-border/60">
                    <span className="text-[10.5px] uppercase tracking-wider text-muted-foreground font-semibold">
                      {SECTION_LABEL[section]}
                    </span>
                    <span className="text-[10px] text-fg-dim tabular-nums">{list.length}</span>
                  </div>
                  <div className="flex-1 p-2 space-y-2">
                    {list.length === 0 ? (
                      <div className="px-2 py-6 text-center pointer-events-none select-none">
                        <p className="text-[11px] font-medium text-muted-foreground">{empty.title}</p>
                        <p className="text-[10px] text-fg-dim mt-0.5">{empty.hint}</p>
                      </div>
                    ) : (
                      list.map((t) => renderCard(t, { kanban: true }))
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {selected.size > 0 && (
        <div className="absolute left-1/2 -translate-x-1/2 bottom-3 z-20 flex items-center gap-2 px-3 py-2 rounded-full bg-card border border-border shadow-lg max-w-[95%]">
          <span className="text-xs font-medium tabular-nums">
            {selected.size} selected
          </span>
          <Button
            size="xs"
            variant="ghost"
            onClick={allSelected ? clearSelect : selectAllVisible}
            title={allSelected ? "Clear selection" : "Select all visible"}
            className="text-fg-dim"
          >
            {allSelected ? "Clear" : "Select all"}
          </Button>
          {onBulkMove && (
            <Select onValueChange={(v) => handleBulkMove(v as TaskSection)} disabled={bulkBusy}>
              <SelectTrigger className="h-7 px-2 text-[11px] gap-1 w-auto">
                <SelectValue placeholder="Move to…" />
              </SelectTrigger>
              <SelectContent>
                {SECTION_ORDER.map((s) => (
                  <SelectItem key={s} value={s}>{SECTION_LABEL[s]}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          {onBulkDelete && (
            <Button
              size="xs"
              variant="ghost"
              onClick={handleBulkDelete}
              disabled={bulkBusy}
              title="Delete selected"
              className="text-destructive hover:bg-destructive/10"
            >
              <Trash2 size={12} />
              Delete
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
