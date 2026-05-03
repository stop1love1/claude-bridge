// TaskGrid — kanban board over the bridge's task meta. Mirrors main's
// `app/_components/TaskGrid.tsx` chrome: a thin search + quick-add
// toolbar above a 4-column kanban with drag-and-drop between columns,
// per-section empty hints, and an inline bulk-action toolbar that
// appears above the grid only when at least one card is selected.
//
// Per-card surface: id, title, body preview (3 lines), per-run status
// dots, age, section pill, archive checkbox (with confirm),
// hover/selected checkbox for bulk operations.

import {
  forwardRef,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import { Link } from "react-router-dom";
import { Check, Trash2, X } from "lucide-react";
import {
  patchTasksMetaCache,
  useCreateTask,
  useDeleteTask,
  usePatchTask,
  useTasksMeta,
} from "@/api/queries";
import { useQueryClient } from "@tanstack/react-query";
import {
  SECTIONS,
  SECTION_LABEL,
  type TaskMeta,
  type TaskSection,
} from "@/api/types";
import StatusDot from "@/components/StatusDot";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useConfirm } from "@/components/ConfirmProvider";
import { useToast } from "@/components/Toasts";
import { relTime } from "@/lib/time";
import { cn } from "@/lib/cn";

const APP_ALL = "__all__";
const APP_AUTO = "__auto__";

// MIME used by the kanban drag-and-drop. Matches main's dashboard so
// the same mechanism survives a future port.
const DND_MIME = "application/x-bridge-task-id";

// Per-section copy for empty Kanban columns. Tailored hints feel more
// purposeful than a generic "empty" stamp and tell the operator what
// dropping a card here means.
const SECTION_EMPTY: Record<TaskSection, { title: string; hint: string }> = {
  TODO: {
    title: "Nothing queued",
    hint: "Drag a card here, or quick-add above.",
  },
  DOING: {
    title: "Idle",
    hint: "Drag a card here to mark it in-progress.",
  },
  BLOCKED: {
    title: "Nothing blocked",
    hint: "Drag a card here when work can't proceed.",
  },
  "DONE — not yet archived": {
    title: "Nothing shipped yet",
    hint: "Tick the checkbox on a card to land it here.",
  },
};

const SECTION_ACCENT: Record<TaskSection, string> = {
  TODO: "border-fg-dim/40",
  DOING: "border-warning/40",
  BLOCKED: "border-destructive/40",
  "DONE — not yet archived": "border-success/40",
};

interface Props {
  /** Slot for the "+ new task" trigger (rendered in the toolbar). */
  newTaskTrigger?: React.ReactNode;
  /**
   * URL-controlled app filter. `__all__` = no filter, `__auto__` =
   * tasks with no app set, anything else = exact app match. The Tasks
   * page mirrors this to `?app=` so the filter survives reloads.
   */
  appFilter?: string;
  onAppFilterChange?: (next: string) => void;
  /** When set, the matching card renders with a primary ring to
   *  indicate it's the task currently open in another pane. */
  activeTaskId?: string | null;
}

export interface TaskGridHandle {
  /** Programmatically focus the search input (used by the "/" hotkey). */
  focusSearch: () => void;
}

const TaskGrid = forwardRef<TaskGridHandle, Props>(function TaskGrid(
  { newTaskTrigger, appFilter: appFilterProp, onAppFilterChange, activeTaskId },
  ref,
) {
  const { data, isLoading, error } = useTasksMeta();

  const [query, setQuery] = useState("");
  const appFilter = appFilterProp ?? APP_ALL;

  // Bulk selection — Set of taskIds. Visible-only (a delete drops the
  // card; we prune `selected` synchronously below so the count never
  // outlasts the data).
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkBusy, setBulkBusy] = useState(false);

  // Drag-and-drop visual state. `draggingId` dims the source card,
  // `dragOverSection` highlights the drop target column.
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dragOverSection, setDragOverSection] = useState<TaskSection | null>(
    null,
  );

  const searchRef = useRef<HTMLInputElement>(null);
  useImperativeHandle(ref, () => ({
    focusSearch: () => searchRef.current?.focus(),
  }));

  const tasks = data?.tasks ?? [];

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return tasks.filter((t) => {
      if (appFilter === APP_AUTO) {
        if (t.taskApp) return false;
      } else if (appFilter !== APP_ALL && (t.taskApp ?? "") !== appFilter) {
        return false;
      }
      if (!q) return true;
      return (
        t.taskId.toLowerCase().includes(q) ||
        (t.taskTitle ?? "").toLowerCase().includes(q) ||
        (t.taskBody ?? "").toLowerCase().includes(q) ||
        (t.taskApp ?? "").toLowerCase().includes(q)
      );
    });
  }, [tasks, query, appFilter]);

  const sorted = useMemo(() => {
    const copy = [...filtered];
    copy.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return copy;
  }, [filtered]);

  const grouped = useMemo(() => {
    const m: Record<TaskSection, TaskMeta[]> = {
      TODO: [],
      DOING: [],
      BLOCKED: [],
      "DONE — not yet archived": [],
    };
    for (const t of sorted) {
      const sec = SECTIONS.includes(t.taskSection) ? t.taskSection : "TODO";
      m[sec].push(t);
    }
    return m;
  }, [sorted]);

  // Drop selected ids that no longer exist in the visible set (e.g.
  // after a bulk delete, or when filters narrow the list). Recompute
  // synchronously during render — React's "previous-render snapshot"
  // pattern: if the cleaned set really shrank we call setSelected and
  // React re-renders without cascading.
  const [prevSorted, setPrevSorted] = useState(sorted);
  if (sorted !== prevSorted) {
    setPrevSorted(sorted);
    const visible = new Set(sorted.map((t) => t.taskId));
    let changed = false;
    const next = new Set<string>();
    for (const id of selected) {
      if (visible.has(id)) next.add(id);
      else changed = true;
    }
    if (changed) setSelected(next);
  }

  const toggleSelect = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const clearSelect = () => setSelected(new Set());
  const selectAllVisible = () =>
    setSelected(new Set(sorted.map((t) => t.taskId)));
  const allSelected = sorted.length > 0 && selected.size === sorted.length;

  // Silence unused-prop warning for `onAppFilterChange` while keeping
  // the prop in the public API (the Tasks page wires it for the URL
  // mirror; future filter UI can call it).
  void onAppFilterChange;

  // ---- Mutations ---------------------------------------------------
  const qc = useQueryClient();
  const patch = usePatchTask();
  const del = useDeleteTask();
  const confirm = useConfirm();
  const toast = useToast();

  const moveTask = async (id: string, section: TaskSection) => {
    // Optimistic — snap the card into the new column before the
    // network round-trip lands.
    patchTasksMetaCache(qc, (list) =>
      list.map((t) =>
        t.taskId === id
          ? {
              ...t,
              taskSection: section,
              taskChecked: section === "DONE — not yet archived",
            }
          : t,
      ),
    );
    try {
      await patch.mutateAsync({
        id,
        patch: {
          section,
          checked: section === "DONE — not yet archived",
        },
      });
    } catch (e) {
      toast.error("Move failed", (e as Error).message);
    }
  };

  const handleBulkMove = async (section: TaskSection) => {
    if (selected.size === 0) return;
    setBulkBusy(true);
    let moved = 0;
    let failed = 0;
    const ids = Array.from(selected);
    const results = await Promise.allSettled(
      ids.map((id) =>
        patch.mutateAsync({
          id,
          patch: {
            section,
            checked: section === "DONE — not yet archived",
          },
        }),
      ),
    );
    for (const r of results) {
      if (r.status === "fulfilled") moved += 1;
      else failed += 1;
    }
    setBulkBusy(false);
    clearSelect();
    if (failed > 0) {
      toast.error(
        `${moved} moved`,
        `${failed} failed → ${SECTION_LABEL[section]}`,
      );
    } else {
      toast.success(`${moved} moved`, `→ ${SECTION_LABEL[section]}`);
    }
  };

  const handleBulkDelete = async () => {
    if (selected.size === 0) return;
    const ok = await confirm({
      title: `Delete ${selected.size} task${selected.size === 1 ? "" : "s"}?`,
      description:
        "Removes per-task sessions/<id>/ metadata and any linked Claude sessions.",
      confirmLabel: "Delete all",
      variant: "destructive",
    });
    if (!ok) return;
    setBulkBusy(true);
    const ids = Array.from(selected);
    const results = await Promise.allSettled(
      ids.map((id) => del.mutateAsync(id)),
    );
    let removed = 0;
    let failed = 0;
    for (const r of results) {
      if (r.status === "fulfilled") removed += 1;
      else failed += 1;
    }
    setBulkBusy(false);
    clearSelect();
    if (failed > 0) {
      toast.error(`${removed} deleted`, `${failed} failed`);
    } else {
      toast.success(`${removed} deleted`);
    }
  };

  // ---- Drag handlers -----------------------------------------------
  const handleCardDragStart =
    (id: string) => (e: React.DragEvent<HTMLDivElement>) => {
      e.dataTransfer.setData(DND_MIME, id);
      e.dataTransfer.effectAllowed = "move";
      setDraggingId(id);
    };
  const handleCardDragEnd = () => {
    setDraggingId(null);
    setDragOverSection(null);
  };
  const onColumnDragOver =
    (section: TaskSection) => (e: React.DragEvent<HTMLDivElement>) => {
      if (!e.dataTransfer.types.includes(DND_MIME)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      if (dragOverSection !== section) setDragOverSection(section);
    };
  const onColumnDragLeave =
    (section: TaskSection) => (e: React.DragEvent<HTMLDivElement>) => {
      // dragleave fires when the cursor enters a child; only clear the
      // hover when the cursor truly leaves the column wrapper.
      if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
      if (dragOverSection === section) setDragOverSection(null);
    };
  const onColumnDrop =
    (section: TaskSection) => (e: React.DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      const id = e.dataTransfer.getData(DND_MIME);
      setDragOverSection(null);
      setDraggingId(null);
      if (!id) return;
      const t = tasks.find((x) => x.taskId === id);
      if (!t || t.taskSection === section) return;
      void moveTask(id, section);
    };

  return (
    <div className="relative space-y-4">
      {/* Toolbar — search + quick-add slot + new-task trigger. Mirrors
          main's terse `flex items-center gap-2` row instead of SPA's
          earlier elaborate filter bar. */}
      <div className="flex items-center gap-2">
        <div className="min-w-[220px] flex-1">
          <input
            ref={searchRef}
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search tasks"
            className="h-7 w-full rounded-md border border-border bg-background px-2 text-xs focus:outline-none focus:border-primary"
          />
        </div>
        <span className="ml-auto" />
        {newTaskTrigger}
      </div>

      {/* Bulk action toolbar — appears inline above the grid only when
          at least one card is selected. */}
      {selected.size > 0 && (
        <div
          className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-card px-3 py-1.5"
          role="toolbar"
          aria-label="Bulk actions"
        >
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
          <Select
            onValueChange={(v) => void handleBulkMove(v as TaskSection)}
            disabled={bulkBusy}
          >
            <SelectTrigger className="h-7 w-auto gap-1 px-2 text-[11px]">
              <SelectValue placeholder="Move to…" />
            </SelectTrigger>
            <SelectContent>
              {SECTIONS.map((s) => (
                <SelectItem key={s} value={s}>
                  {SECTION_LABEL[s]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            size="xs"
            variant="ghost"
            onClick={() => void handleBulkDelete()}
            disabled={bulkBusy}
            title="Delete selected"
            className="text-destructive hover:bg-destructive/10"
          >
            <Trash2 size={12} />
            Delete
          </Button>
          <Button
            size="xs"
            variant="ghost"
            onClick={clearSelect}
            title="Cancel"
            className="ml-auto text-muted-foreground"
          >
            <X size={12} />
            Cancel
          </Button>
        </div>
      )}

      {/* Quick-add inline input. Mirrors main's lines 371-386: plus
          icon + Enter-to-create. */}
      <QuickAddRow />

      {error && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 px-4 py-3 text-small text-destructive">
          {(error as Error).message}
        </div>
      )}
      {isLoading && (
        <div className="font-mono text-micro tracking-wideish text-muted-foreground">
          Loading sessions…
        </div>
      )}

      {/* Body — kanban only. Drop the SPA's old view toggle. */}
      <div className="grid grid-cols-1 gap-x-6 gap-y-10 md:grid-cols-2 xl:grid-cols-4">
        {SECTIONS.map((s) => {
          const isDropTarget = dragOverSection === s;
          return (
            <KanbanColumn
              key={s}
              section={s}
              tasks={grouped[s]}
              isDropTarget={isDropTarget}
              onDragOver={onColumnDragOver(s)}
              onDragLeave={onColumnDragLeave(s)}
              onDrop={onColumnDrop(s)}
              draggingId={draggingId}
              onCardDragStart={handleCardDragStart}
              onCardDragEnd={handleCardDragEnd}
              selected={selected}
              onToggleSelect={toggleSelect}
              activeTaskId={activeTaskId ?? null}
            />
          );
        })}
      </div>

      {sorted.length === 0 && !isLoading && (
        <div className="rounded-lg border border-dashed border-border bg-card/50 p-10 text-center text-small text-muted-foreground">
          No tasks match these filters.
        </div>
      )}
    </div>
  );
});

export default TaskGrid;

// ---- subviews -----------------------------------------------------------

function QuickAddRow() {
  const [body, setBody] = useState("");
  const toast = useToast();
  const qc = useQueryClient();
  const create = useCreateTask();

  const submit = async () => {
    const v = body.trim();
    if (!v) return;
    try {
      const t = await create.mutateAsync({ body: v });
      // Refresh the meta cache so the card appears immediately —
      // useCreateTask invalidates `tasks` but not the keyed-map cache
      // some places consume.
      qc.invalidateQueries({ queryKey: ["tasks", "meta"] });
      toast.success("Created", t.id);
      setBody("");
    } catch (e) {
      toast.error("Create failed", (e as Error).message);
    }
  };

  return (
    <div className="flex items-center gap-2 rounded-md border border-border bg-card px-3 py-1.5">
      <span className="text-fg-dim" aria-hidden="true">
        +
      </span>
      <input
        value={body}
        onChange={(e) => setBody(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            void submit();
          } else if (e.key === "Escape") {
            setBody("");
          }
        }}
        placeholder="Quick add — press Enter"
        className="flex-1 bg-transparent text-xs placeholder:text-fg-dim focus:outline-none"
        aria-label="Quick-add task"
      />
    </div>
  );
}

interface KanbanColumnProps {
  section: TaskSection;
  tasks: TaskMeta[];
  isDropTarget: boolean;
  onDragOver: (e: React.DragEvent<HTMLDivElement>) => void;
  onDragLeave: (e: React.DragEvent<HTMLDivElement>) => void;
  onDrop: (e: React.DragEvent<HTMLDivElement>) => void;
  draggingId: string | null;
  onCardDragStart: (
    id: string,
  ) => (e: React.DragEvent<HTMLDivElement>) => void;
  onCardDragEnd: () => void;
  selected: Set<string>;
  onToggleSelect: (id: string) => void;
  activeTaskId: string | null;
}

function KanbanColumn({
  section,
  tasks,
  isDropTarget,
  onDragOver,
  onDragLeave,
  onDrop,
  draggingId,
  onCardDragStart,
  onCardDragEnd,
  selected,
  onToggleSelect,
  activeTaskId,
}: KanbanColumnProps) {
  const empty = SECTION_EMPTY[section];
  return (
    <section
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      className={cn(
        "flex min-w-0 flex-col rounded-lg border-2 transition-colors",
        isDropTarget
          ? "border-primary bg-primary/10"
          : `${SECTION_ACCENT[section]} bg-secondary/30`,
      )}
    >
      <header className="flex items-center justify-between border-b border-border/60 px-3 py-2">
        <span className="text-[10.5px] font-semibold uppercase tracking-wider text-muted-foreground">
          {SECTION_LABEL[section]}
        </span>
        <span className="text-[10px] tabular-nums text-fg-dim">
          {tasks.length}
        </span>
      </header>
      <div className="flex flex-1 flex-col gap-2 p-2">
        {tasks.length === 0 ? (
          <div className="select-none px-2 py-6 text-center pointer-events-none">
            <p className="text-[11px] font-medium text-muted-foreground">
              {empty.title}
            </p>
            <p className="mt-0.5 text-[10px] text-fg-dim">{empty.hint}</p>
          </div>
        ) : (
          tasks.map((t) => (
            <TaskCardFull
              task={t}
              key={t.taskId}
              draggable
              isDragging={draggingId === t.taskId}
              onDragStart={onCardDragStart(t.taskId)}
              onDragEnd={onCardDragEnd}
              isSelected={selected.has(t.taskId)}
              onToggleSelect={() => onToggleSelect(t.taskId)}
              isActive={activeTaskId === t.taskId}
            />
          ))
        )}
      </div>
    </section>
  );
}

// ---- card ---------------------------------------------------------

function preview(body: string, max = 220): string {
  const cleaned = body
    .replace(/\r\n/g, "\n")
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .slice(0, 3)
    .join(" · ");
  return cleaned.length > max ? cleaned.slice(0, max - 1) + "…" : cleaned;
}

function ArchiveCheckbox({ task }: { task: TaskMeta }) {
  const patch = usePatchTask();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const toast = useToast();

  const onChange = async (next: boolean) => {
    const ok = await confirm({
      title: next ? "Mark task done?" : "Un-archive task?",
      description: next
        ? "Moves the card to the done column and ticks the archive box."
        : "Drops the archive flag — task returns to its current section.",
      confirmLabel: next ? "Mark done" : "Un-archive",
    });
    if (!ok) return;
    patchTasksMetaCache(qc, (list) =>
      list.map((t) =>
        t.taskId === task.taskId
          ? {
              ...t,
              taskChecked: next,
              taskSection: next ? "DONE — not yet archived" : t.taskSection,
            }
          : t,
      ),
    );
    try {
      await patch.mutateAsync({
        id: task.taskId,
        patch: {
          checked: next,
          section: next ? "DONE — not yet archived" : task.taskSection,
        },
      });
    } catch (e) {
      toast.error("Update failed", (e as Error).message);
    }
  };

  return (
    <input
      type="checkbox"
      aria-label="Archive task"
      checked={task.taskChecked}
      onChange={(e) => void onChange(e.target.checked)}
      onClick={(e) => e.stopPropagation()}
      className="h-3.5 w-3.5 cursor-pointer accent-accent"
    />
  );
}

function SelectCheckbox({
  selected,
  onToggle,
  taskId,
}: {
  selected: boolean;
  onToggle: () => void;
  taskId: string;
}) {
  return (
    <button
      type="button"
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onToggle();
      }}
      aria-pressed={selected}
      aria-label={
        selected ? `Deselect task ${taskId}` : `Select task ${taskId}`
      }
      className={cn(
        "flex h-4 w-4 shrink-0 items-center justify-center rounded border transition-colors",
        selected
          ? "border-primary bg-primary text-primary-foreground"
          : "border-border bg-background opacity-0 group-hover:opacity-100 focus-visible:opacity-100",
      )}
    >
      {selected && <Check size={11} strokeWidth={3} />}
    </button>
  );
}

interface TaskCardFullProps {
  task: TaskMeta;
  draggable?: boolean;
  isDragging?: boolean;
  onDragStart?: (e: React.DragEvent<HTMLDivElement>) => void;
  onDragEnd?: () => void;
  isSelected: boolean;
  onToggleSelect: () => void;
  isActive: boolean;
}

function TaskCardFull({
  task,
  draggable,
  isDragging,
  onDragStart,
  onDragEnd,
  isSelected,
  onToggleSelect,
  isActive,
}: TaskCardFullProps) {
  const runs = task.runs ?? [];
  const lastRun = runs[runs.length - 1];
  const liveRuns = runs.filter((r) => r.status === "running").length;

  return (
    <div
      draggable={draggable}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      className={cn(
        "group relative",
        draggable && "cursor-grab active:cursor-grabbing",
        isDragging && "opacity-40",
      )}
    >
      <Link
        to={`/tasks/${task.taskId}`}
        className={cn(
          "block rounded-lg border bg-card p-3 transition-colors",
          "hover:bg-accent",
          isSelected
            ? "border-primary/70 ring-1 ring-primary/40"
            : isActive
              ? "border-primary ring-2 ring-primary"
              : "border-border hover:border-input",
          liveRuns > 0 && !isSelected && !isActive && "ring-1 ring-warning/30",
        )}
      >
        <div className="flex items-start gap-2">
          <SelectCheckbox
            selected={isSelected}
            onToggle={onToggleSelect}
            taskId={task.taskId}
          />
          <div className="flex min-w-0 flex-1 items-start justify-between gap-3">
            <span className="shrink-0 font-mono text-micro tracking-wideish text-fg-dim">
              {task.taskId}
            </span>
            <div className="flex shrink-0 items-center gap-2">
              <span className="font-mono text-micro tabular-nums text-fg-dim">
                {relTime(task.createdAt)}
              </span>
              <ArchiveCheckbox task={task} />
            </div>
          </div>
        </div>

        <h3 className="ml-6 mt-2 text-[13px] font-medium leading-snug text-foreground group-hover:text-primary sm:text-sm">
          {task.taskTitle || (
            <span className="italic text-muted-foreground">Untitled task</span>
          )}
        </h3>

        {task.taskBody && (
          <p className="ml-6 mt-2 line-clamp-3 text-small text-muted-foreground">
            {preview(task.taskBody)}
          </p>
        )}

        {(runs.length > 0 || task.taskApp) && (
          <div className="ml-6 mt-3 flex items-center justify-between gap-3">
            <div className="flex items-center gap-1.5">
              {runs.slice(-8).map((run) => (
                <StatusDot key={run.sessionId} status={run.status} size="xs" />
              ))}
              {runs.length > 8 && (
                <span className="font-mono text-micro text-fg-dim">
                  +{runs.length - 8}
                </span>
              )}
            </div>
            <div className="flex items-center gap-3 text-[10px] text-fg-dim">
              {task.taskApp && (
                <span className="truncate font-mono" title={task.taskApp}>
                  {task.taskApp}
                </span>
              )}
              {liveRuns > 0 && (
                <span className="text-warning">↏ {liveRuns} live</span>
              )}
              {!liveRuns && lastRun && (
                <span className="uppercase">{lastRun.role}</span>
              )}
            </div>
          </div>
        )}
      </Link>
    </div>
  );
}
