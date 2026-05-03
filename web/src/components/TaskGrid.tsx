// TaskGrid — replaces the v0.1 Board's hardcoded 4-column layout with
// a filter / sort / view-toggle surface that handles both kanban and
// flat-list arrangements over the same underlying data.
//
// Filters: free-text search (matches title / body / id / app), section
// multi-select, app dropdown.
// Sort: created-desc (default) | updated-desc (proxied via the most-
// recent run on each task — meta.json has no updatedAt today).
// View: kanban (4 columns) or flat list (one row per task), with
// drag-and-drop between kanban columns.
//
// Per-card surface: id, title, body preview (3 lines), per-run status
// dots, age, section pill, archive checkbox (with confirm),
// hover/selected checkbox for bulk operations, role icon (Crown for
// coordinator, Sparkles otherwise).

import {
  forwardRef,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import { Link } from "react-router-dom";
import {
  Check,
  Crown,
  Filter,
  KanbanSquare,
  List,
  Search,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";
import {
  patchTasksMetaCache,
  useCreateTask,
  useDeleteTask,
  usePatchTask,
  useTasksMeta,
  useApps,
} from "@/api/queries";
import { useQueryClient } from "@tanstack/react-query";
import {
  SECTIONS,
  SECTION_LABEL,
  type TaskMeta,
  type TaskSection,
} from "@/api/types";
import StatusDot from "@/components/StatusDot";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useConfirm } from "@/components/ConfirmProvider";
import { useToast } from "@/components/Toasts";
import { useLocalStorage } from "@/lib/useLocalStorage";
import { relTime } from "@/lib/time";
import { cn } from "@/lib/cn";

type SortKey = "created-desc" | "updated-desc";
type ViewMode = "kanban" | "list";

const APP_ALL = "__all__";
const APP_AUTO = "__auto__";

// MIME used by the kanban drag-and-drop. Keep in sync with main's
// dashboard so the same mechanism survives a future port.
const DND_MIME = "application/x-bridge-task-id";

const LAYOUT_KEY = "bridge.tasks.layout";
const loadLayout = (raw: string | null): ViewMode =>
  raw === "list" ? "list" : "kanban";
const dumpLayout = (v: ViewMode): string => v;

// Per-section copy for empty Kanban columns. Tailored hints feel more
// purposeful than a generic "empty." stamp and tell the operator what
// dropping a card here means.
const SECTION_EMPTY: Record<TaskSection, { title: string; hint: string }> = {
  TODO: {
    title: "nothing queued",
    hint: "drag a card here, or quick-add above.",
  },
  DOING: {
    title: "idle",
    hint: "drag a card here to mark it in-progress.",
  },
  BLOCKED: {
    title: "nothing blocked",
    hint: "drag a card here when work can't proceed.",
  },
  "DONE — not yet archived": {
    title: "nothing shipped yet",
    hint: "tick the checkbox on a card to land it here.",
  },
};

// Lucide icons are ForwardRef SVG components — typing the registry as
// `ComponentType<any>` keeps the call sites readable without fighting
// the variadic prop shapes under strict mode (mirrors how
// CommandPalette already types its role-icon slots).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type IconComponent = React.ComponentType<any>;

const ROLE_ICON: Record<string, IconComponent> = {
  coordinator: Crown,
};
const ROLE_COLOR: Record<string, string> = {
  coordinator: "text-status-doing",
};

function roleIcon(role: string) {
  return ROLE_ICON[role] ?? Sparkles;
}
function roleColor(role: string) {
  return ROLE_COLOR[role] ?? "text-muted-foreground";
}

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
  const { data: apps } = useApps();

  const [query, setQuery] = useState("");
  const [internalAppFilter, setInternalAppFilter] = useState<string>(APP_ALL);
  const appFilter = appFilterProp ?? internalAppFilter;
  const setAppFilter = (v: string) => {
    if (onAppFilterChange) onAppFilterChange(v);
    else setInternalAppFilter(v);
  };
  const [sectionFilter, setSectionFilter] = useState<Set<TaskSection>>(
    new Set(SECTIONS),
  );
  const [sort, setSort] = useState<SortKey>("created-desc");
  const [view, setView] = useLocalStorage<ViewMode>(
    LAYOUT_KEY,
    loadLayout,
    "kanban",
    dumpLayout,
  );

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
      if (!sectionFilter.has(t.taskSection)) return false;
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
  }, [tasks, query, appFilter, sectionFilter]);

  const sorted = useMemo(() => {
    const copy = [...filtered];
    if (sort === "updated-desc") {
      const lastTouch = (t: TaskMeta) => {
        let max = t.createdAt;
        for (const r of t.runs) {
          const ended = r.endedAt ?? r.startedAt ?? null;
          if (ended && ended > max) max = ended;
        }
        return max;
      };
      copy.sort((a, b) => lastTouch(b).localeCompare(lastTouch(a)));
    } else {
      copy.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    }
    return copy;
  }, [filtered, sort]);

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

  const toggleSection = (s: TaskSection) =>
    setSectionFilter((prev) => {
      const next = new Set(prev);
      if (next.has(s)) next.delete(s);
      else next.add(s);
      // Don't allow zero — clearing the last one resets to "all".
      if (next.size === 0) return new Set(SECTIONS);
      return next;
    });

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
      toast.error("move failed", (e as Error).message);
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
      title: `delete ${selected.size} task${selected.size === 1 ? "" : "s"}?`,
      description:
        "removes per-task sessions/<id>/ metadata and any linked claude sessions.",
      confirmLabel: "delete all",
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
    <div className="relative space-y-6">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-[220px] flex-1">
          <Search
            size={12}
            className="absolute left-2 top-1/2 -translate-y-1/2 text-fg-dim"
          />
          <Input
            ref={searchRef}
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="search title, body, id, app…  (press / to focus)"
            className="pl-7 pr-7"
          />
          {query && (
            <button
              type="button"
              onClick={() => setQuery("")}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-fg-dim hover:text-foreground"
              aria-label="clear search"
            >
              <X size={11} />
            </button>
          )}
        </div>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="sm" className="gap-1.5">
              <Filter size={12} />
              sections
              {sectionFilter.size < SECTIONS.length && (
                <span className="rounded-full bg-primary px-1 text-[10px] text-bg">
                  {sectionFilter.size}
                </span>
              )}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            <DropdownMenuLabel>section filter</DropdownMenuLabel>
            <DropdownMenuSeparator />
            {SECTIONS.map((s) => (
              <DropdownMenuCheckboxItem
                key={s}
                checked={sectionFilter.has(s)}
                onCheckedChange={() => toggleSection(s)}
              >
                {SECTION_LABEL[s]}
              </DropdownMenuCheckboxItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>

        <Select value={appFilter} onValueChange={setAppFilter}>
          <SelectTrigger className="w-[170px]" title="filter tasks by target app">
            <SelectValue placeholder="app" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={APP_ALL}>— any app —</SelectItem>
            <SelectItem value={APP_AUTO}>auto (no app set)</SelectItem>
            {(apps?.apps ?? []).map((a) => (
              <SelectItem key={a.name} value={a.name}>
                {a.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select value={sort} onValueChange={(v) => setSort(v as SortKey)}>
          <SelectTrigger className="w-[160px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="created-desc">created · newest</SelectItem>
            <SelectItem value="updated-desc">updated · newest</SelectItem>
          </SelectContent>
        </Select>

        <Tabs value={view} onValueChange={(v) => setView(v as ViewMode)}>
          <TabsList>
            <TabsTrigger value="kanban" className="gap-1.5">
              <KanbanSquare size={12} />
              kanban
            </TabsTrigger>
            <TabsTrigger value="list" className="gap-1.5">
              <List size={12} />
              list
            </TabsTrigger>
          </TabsList>
        </Tabs>

        <span className="ml-auto" />
        {newTaskTrigger}
      </div>

      {/* Quick-add inline input. Mirrors main's lines 224-238: plus
          icon + Enter-to-create, calls the same `useCreateTask`
          mutation indirectly via NewTaskDialog parity. */}
      <QuickAddRow />

      {error && (
        <div className="rounded-sm border border-status-blocked/40 bg-status-blocked/10 px-4 py-3 font-mono text-small text-status-blocked">
          {(error as Error).message}
        </div>
      )}
      {isLoading && (
        <div className="font-mono text-micro tracking-wideish text-muted-foreground">
          loading sessions…
        </div>
      )}

      {/* Body */}
      {view === "kanban" ? (
        <div className="grid grid-cols-1 gap-x-6 gap-y-10 md:grid-cols-2 xl:grid-cols-4">
          {SECTIONS.filter((s) => sectionFilter.has(s)).map((s) => {
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
      ) : (
        <FlatList
          tasks={sorted}
          selected={selected}
          onToggleSelect={toggleSelect}
          activeTaskId={activeTaskId ?? null}
        />
      )}

      {sorted.length === 0 && !isLoading && (
        <div className="rounded-sm border border-dashed border-border bg-card/50 p-10 text-center font-mono text-micro tracking-wideish text-muted-foreground">
          no tasks match these filters.
        </div>
      )}

      {/* Floating bulk action bar */}
      {selected.size > 0 && (
        <div
          className="fixed left-1/2 bottom-4 z-30 flex -translate-x-1/2 items-center gap-2 rounded-full border border-border bg-card px-3 py-2 shadow-lg max-w-[95%]"
          role="toolbar"
          aria-label="Bulk actions"
        >
          <span className="font-mono text-xs tabular-nums">
            {selected.size} selected
          </span>
          <Button
            size="xs"
            variant="ghost"
            onClick={allSelected ? clearSelect : selectAllVisible}
            title={allSelected ? "clear selection" : "select all visible"}
            className="text-fg-dim"
          >
            {allSelected ? "clear" : "select all"}
          </Button>
          <Select
            onValueChange={(v) => void handleBulkMove(v as TaskSection)}
            disabled={bulkBusy}
          >
            <SelectTrigger className="h-7 w-auto gap-1 px-2 text-[11px]">
              <SelectValue placeholder="move to…" />
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
            title="delete selected"
            className="text-status-blocked hover:bg-status-blocked/10"
          >
            <Trash2 size={12} />
            delete
          </Button>
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
      toast.success("created", t.id);
      setBody("");
    } catch (e) {
      toast.error("create failed", (e as Error).message);
    }
  };

  return (
    <div className="flex items-center gap-2 rounded-sm border border-border bg-card px-3 py-2">
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
        placeholder="quick add — press Enter"
        className="flex-1 bg-transparent text-xs placeholder:text-fg-dim focus:outline-none"
        aria-label="quick-add task"
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
  const ACCENT: Record<TaskSection, string> = {
    TODO: "bg-status-todo",
    DOING: "bg-status-doing",
    BLOCKED: "bg-status-blocked",
    "DONE — not yet archived": "bg-status-done",
  };
  const empty = SECTION_EMPTY[section];
  return (
    <section
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      className={cn(
        "flex min-w-0 flex-col rounded-sm transition-colors",
        isDropTarget && "bg-primary/5 ring-1 ring-primary/40",
      )}
    >
      <header className="mb-4 flex items-baseline gap-3 border-b border-border pb-2">
        <span
          className={cn(
            "h-1.5 w-1.5 self-center rounded-full",
            ACCENT[section],
          )}
        />
        <h2 className="font-mono text-micro uppercase tracking-wideish text-foreground">
          {SECTION_LABEL[section]}
        </h2>
        <span className="ml-auto font-mono text-micro tabular-nums text-fg-dim">
          {String(tasks.length).padStart(2, "0")}
        </span>
      </header>
      <div className="flex flex-col gap-3">
        {tasks.length === 0 ? (
          <div className="rounded-sm border border-dashed border-border bg-card/40 px-3 py-6 text-center">
            <p className="font-mono text-micro uppercase tracking-wideish text-muted-foreground">
              {empty.title}
            </p>
            <p className="mt-1 text-[10px] text-fg-dim">{empty.hint}</p>
          </div>
        ) : (
          tasks.map((t, i) => (
            <TaskCardFull
              task={t}
              index={i}
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

function FlatList({
  tasks,
  selected,
  onToggleSelect,
  activeTaskId,
}: {
  tasks: TaskMeta[];
  selected: Set<string>;
  onToggleSelect: (id: string) => void;
  activeTaskId: string | null;
}) {
  return (
    <ul className="divide-y divide-border rounded-sm border border-border bg-card">
      {tasks.map((t, i) => (
        <li key={t.taskId} className="px-4 py-3">
          <TaskRowFlat
            task={t}
            index={i}
            isSelected={selected.has(t.taskId)}
            onToggleSelect={() => onToggleSelect(t.taskId)}
            isActive={activeTaskId === t.taskId}
          />
        </li>
      ))}
    </ul>
  );
}

// ---- card / row ---------------------------------------------------------

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
      title: next ? "mark task done?" : "un-archive task?",
      description: next
        ? "moves the card to the done column and ticks the archive box."
        : "drops the archive flag — task returns to its current section.",
      confirmLabel: next ? "mark done" : "un-archive",
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
      toast.error("update failed", (e as Error).message);
    }
  };

  return (
    <input
      type="checkbox"
      aria-label="archive task"
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
        selected ? `deselect task ${taskId}` : `select task ${taskId}`
      }
      className={cn(
        "flex h-4 w-4 shrink-0 items-center justify-center rounded-sm border transition-colors",
        selected
          ? "border-primary bg-primary text-primary-foreground"
          : "border-border bg-background opacity-0 group-hover:opacity-100 focus-visible:opacity-100",
      )}
    >
      {selected && <Check size={11} strokeWidth={3} />}
    </button>
  );
}

function RoleBadges({ task }: { task: TaskMeta }) {
  const runs = task.runs ?? [];
  const roleSet = Array.from(new Set(runs.map((r) => r.role)));
  if (roleSet.length === 0) return null;
  return (
    <span className="inline-flex items-center gap-1">
      {roleSet.map((role) => {
        const Icon = roleIcon(role);
        return (
          <Icon
            key={role}
            size={11}
            className={cn("shrink-0", roleColor(role))}
            aria-label={role}
          />
        );
      })}
    </span>
  );
}

interface TaskCardFullProps {
  task: TaskMeta;
  index: number;
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
  index,
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
  const delay = `${Math.min(index * 30, 360)}ms`;

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
        style={{ animationDelay: delay }}
        className={cn(
          "block rounded-sm border bg-card p-4 animate-fade-up transition-all duration-200",
          "hover:-translate-y-px hover:bg-secondary",
          isSelected
            ? "border-primary/60 ring-1 ring-primary/40"
            : isActive
              ? "border-primary ring-2 ring-primary/40"
              : "border-border hover:border-input",
        )}
      >
        <div className="flex items-start gap-2">
          <SelectCheckbox
            selected={isSelected}
            onToggle={onToggleSelect}
            taskId={task.taskId}
          />
          <div className="flex flex-1 items-start justify-between gap-3 min-w-0">
            <span className="font-mono text-micro tracking-wideish text-fg-dim shrink-0">
              {task.taskId}
            </span>
            <div className="flex items-center gap-2 shrink-0">
              <span className="font-mono text-micro tabular-nums text-fg-dim">
                {relTime(task.createdAt)}
              </span>
              <ArchiveCheckbox task={task} />
            </div>
          </div>
        </div>

        <h3 className="ml-6 mt-2 font-sans text-base font-medium leading-snug text-foreground group-hover:text-primary">
          {task.taskTitle || (
            <span className="italic text-muted-foreground">untitled task</span>
          )}
        </h3>

        {task.taskBody && (
          <p className="ml-6 mt-2 line-clamp-3 text-small text-muted-foreground">
            {preview(task.taskBody)}
          </p>
        )}

        {(runs.length > 0 || task.taskApp) && (
          <div className="ml-6 mt-4 flex items-center justify-between gap-3">
            <div className="flex items-center gap-1.5">
              <RoleBadges task={task} />
              {runs.slice(-8).map((run) => (
                <StatusDot key={run.sessionId} status={run.status} size="xs" />
              ))}
              {runs.length > 8 && (
                <span className="font-mono text-micro text-fg-dim">
                  +{runs.length - 8}
                </span>
              )}
            </div>
            <div className="flex items-center gap-3 font-mono text-micro tracking-wideish text-fg-dim">
              {task.taskApp && (
                <span className="truncate" title={task.taskApp}>
                  {task.taskApp}
                </span>
              )}
              {liveRuns > 0 && (
                <span className="text-status-doing">↏ {liveRuns} live</span>
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

function TaskRowFlat({
  task,
  index,
  isSelected,
  onToggleSelect,
  isActive,
}: {
  task: TaskMeta;
  index: number;
  isSelected: boolean;
  onToggleSelect: () => void;
  isActive: boolean;
}) {
  const runs = task.runs ?? [];
  const liveRuns = runs.filter((r) => r.status === "running").length;
  const delay = `${Math.min(index * 15, 240)}ms`;
  return (
    <Link
      to={`/tasks/${task.taskId}`}
      style={{ animationDelay: delay }}
      className={cn(
        "group flex animate-fade-up items-center gap-4 rounded-sm hover:bg-secondary",
        isActive && "ring-2 ring-primary/40 bg-primary/5",
      )}
    >
      <SelectCheckbox
        selected={isSelected}
        onToggle={onToggleSelect}
        taskId={task.taskId}
      />
      <span className="w-32 shrink-0 font-mono text-micro tracking-wideish text-fg-dim">
        {task.taskId}
      </span>
      <span className="w-24 shrink-0 font-mono text-micro uppercase tracking-wideish text-muted-foreground">
        {task.taskSection.replace(" — not yet archived", "")}
      </span>
      <span className="flex-1 truncate font-sans text-small text-foreground group-hover:text-primary">
        {task.taskTitle || <em className="text-muted-foreground">untitled task</em>}
      </span>
      <RoleBadges task={task} />
      <div className="flex w-[120px] items-center gap-1">
        {runs.slice(-6).map((r) => (
          <StatusDot key={r.sessionId} status={r.status} size="xs" />
        ))}
        {liveRuns > 0 && (
          <span className="font-mono text-[10px] text-status-doing">
            ↏{liveRuns}
          </span>
        )}
      </div>
      <span className="w-16 shrink-0 truncate text-right font-mono text-micro text-fg-dim">
        {task.taskApp ?? "—"}
      </span>
      <span className="w-12 shrink-0 text-right font-mono text-micro tabular-nums text-fg-dim">
        {relTime(task.createdAt)}
      </span>
      <span onClick={(e) => e.preventDefault()}>
        <ArchiveCheckbox task={task} />
      </span>
    </Link>
  );
}
