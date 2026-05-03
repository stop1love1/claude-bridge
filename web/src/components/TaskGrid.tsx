// TaskGrid — replaces the v0.1 Board's hardcoded 4-column layout with
// a filter / sort / view-toggle surface that handles both kanban and
// flat-list arrangements over the same underlying data.
//
// Filters: free-text search (matches title / body / id / app), section
// multi-select, app dropdown.
// Sort: created-desc (default) | updated-desc (proxied via the most-
// recent run on each task — meta.json has no updatedAt today).
// View: kanban (4 columns) or flat list (one row per task).
//
// Per-card surface: id, title, body preview (3 lines), per-run status
// dots, age, section pill, archive checkbox (with confirm).

import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import {
  Filter,
  KanbanSquare,
  List,
  Search,
  X,
} from "lucide-react";
import {
  patchTasksMetaCache,
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
import { relTime } from "@/lib/time";
import { cn } from "@/lib/cn";

type SortKey = "created-desc" | "updated-desc";
type ViewMode = "kanban" | "list";

const APP_ALL = "__all__";

interface Props {
  /** Slot for the "+ new task" trigger (rendered in the toolbar). */
  newTaskTrigger?: React.ReactNode;
}

export default function TaskGrid({ newTaskTrigger }: Props) {
  const { data, isLoading, error } = useTasksMeta();
  const { data: apps } = useApps();

  const [query, setQuery] = useState("");
  const [appFilter, setAppFilter] = useState<string>(APP_ALL);
  const [sectionFilter, setSectionFilter] = useState<Set<TaskSection>>(
    new Set(SECTIONS),
  );
  const [sort, setSort] = useState<SortKey>("created-desc");
  const [view, setView] = useState<ViewMode>("kanban");

  const tasks = data?.tasks ?? [];

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return tasks.filter((t) => {
      if (!sectionFilter.has(t.taskSection)) return false;
      if (appFilter !== APP_ALL && (t.taskApp ?? "") !== appFilter) return false;
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

  const toggleSection = (s: TaskSection) =>
    setSectionFilter((prev) => {
      const next = new Set(prev);
      if (next.has(s)) next.delete(s);
      else next.add(s);
      // Don't allow zero — clearing the last one resets to "all".
      if (next.size === 0) return new Set(SECTIONS);
      return next;
    });

  return (
    <div className="space-y-6">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-[220px] flex-1">
          <Search
            size={12}
            className="absolute left-2 top-1/2 -translate-y-1/2 text-muted-2"
          />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="search title, body, id, app…"
            className="pl-7 pr-7"
          />
          {query && (
            <button
              type="button"
              onClick={() => setQuery("")}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-2 hover:text-fg"
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
                <span className="rounded-full bg-accent px-1 text-[10px] text-bg">
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
          <SelectTrigger className="w-[160px]">
            <SelectValue placeholder="app" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={APP_ALL}>— any app —</SelectItem>
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

      {error && (
        <div className="rounded-sm border border-status-blocked/40 bg-status-blocked/10 px-4 py-3 font-mono text-small text-status-blocked">
          {(error as Error).message}
        </div>
      )}
      {isLoading && (
        <div className="font-mono text-micro tracking-wideish text-muted">
          loading sessions…
        </div>
      )}

      {/* Body */}
      {view === "kanban" ? (
        <div className="grid grid-cols-1 gap-x-6 gap-y-10 md:grid-cols-2 xl:grid-cols-4">
          {SECTIONS.filter((s) => sectionFilter.has(s)).map((s) => (
            <KanbanColumn
              key={s}
              section={s}
              tasks={grouped[s]}
            />
          ))}
        </div>
      ) : (
        <FlatList tasks={sorted} />
      )}

      {sorted.length === 0 && !isLoading && (
        <div className="rounded-sm border border-dashed border-border bg-surface/50 p-10 text-center font-mono text-micro tracking-wideish text-muted">
          no tasks match these filters.
        </div>
      )}
    </div>
  );
}

// ---- subviews -----------------------------------------------------------

function KanbanColumn({
  section,
  tasks,
}: {
  section: TaskSection;
  tasks: TaskMeta[];
}) {
  const ACCENT: Record<TaskSection, string> = {
    TODO: "bg-status-todo",
    DOING: "bg-status-doing",
    BLOCKED: "bg-status-blocked",
    "DONE — not yet archived": "bg-status-done",
  };
  return (
    <section className="flex min-w-0 flex-col">
      <header className="mb-4 flex items-baseline gap-3 border-b border-border pb-2">
        <span
          className={cn(
            "h-1.5 w-1.5 self-center rounded-full",
            ACCENT[section],
          )}
        />
        <h2 className="font-mono text-micro uppercase tracking-wideish text-fg">
          {SECTION_LABEL[section]}
        </h2>
        <span className="ml-auto font-mono text-micro tabular-nums text-muted-2">
          {String(tasks.length).padStart(2, "0")}
        </span>
      </header>
      <div className="flex flex-col gap-3">
        {tasks.length === 0 ? (
          <p className="rounded-sm border border-dashed border-border px-3 py-4 font-mono text-micro tracking-wideish text-muted-2">
            empty.
          </p>
        ) : (
          tasks.map((t, i) => <TaskCardFull task={t} index={i} key={t.taskId} />)
        )}
      </div>
    </section>
  );
}

function FlatList({ tasks }: { tasks: TaskMeta[] }) {
  return (
    <ul className="divide-y divide-border rounded-sm border border-border bg-surface">
      {tasks.map((t, i) => (
        <li key={t.taskId} className="px-4 py-3">
          <TaskRowFlat task={t} index={i} />
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
    // Optimistic: flip the cache immediately, before the mutation
    // resolves, so the user sees their click land.
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

function TaskCardFull({ task, index }: { task: TaskMeta; index: number }) {
  const runs = task.runs ?? [];
  const lastRun = runs[runs.length - 1];
  const liveRuns = runs.filter((r) => r.status === "running").length;
  const delay = `${Math.min(index * 30, 360)}ms`;

  return (
    <Link
      to={`/tasks/${task.taskId}`}
      style={{ animationDelay: delay }}
      className={cn(
        "group block rounded-sm border border-border bg-surface p-4",
        "animate-fade-up transition-all duration-200",
        "hover:-translate-y-px hover:border-border-strong hover:bg-surface-2",
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <span className="font-mono text-micro tracking-wideish text-muted-2">
          {task.taskId}
        </span>
        <div className="flex items-center gap-2">
          <span className="font-mono text-micro tabular-nums text-muted-2">
            {relTime(task.createdAt)}
          </span>
          <ArchiveCheckbox task={task} />
        </div>
      </div>

      <h3 className="mt-2 font-sans text-base font-medium leading-snug text-fg group-hover:text-accent">
        {task.taskTitle || (
          <span className="italic text-muted">untitled task</span>
        )}
      </h3>

      {task.taskBody && (
        <p className="mt-2 line-clamp-3 text-small text-muted">
          {preview(task.taskBody)}
        </p>
      )}

      {(runs.length > 0 || task.taskApp) && (
        <div className="mt-4 flex items-center justify-between gap-3">
          <div className="flex items-center gap-1.5">
            {runs.slice(-8).map((run) => (
              <StatusDot key={run.sessionId} status={run.status} size="xs" />
            ))}
            {runs.length > 8 && (
              <span className="font-mono text-micro text-muted-2">
                +{runs.length - 8}
              </span>
            )}
          </div>
          <div className="flex items-center gap-3 font-mono text-micro tracking-wideish text-muted-2">
            {task.taskApp && (
              <span className="truncate" title={task.taskApp}>
                {task.taskApp}
              </span>
            )}
            {liveRuns > 0 && (
              <span className="text-status-doing">● {liveRuns} live</span>
            )}
            {!liveRuns && lastRun && (
              <span className="uppercase">{lastRun.role}</span>
            )}
          </div>
        </div>
      )}
    </Link>
  );
}

function TaskRowFlat({ task, index }: { task: TaskMeta; index: number }) {
  const runs = task.runs ?? [];
  const liveRuns = runs.filter((r) => r.status === "running").length;
  const delay = `${Math.min(index * 15, 240)}ms`;
  return (
    <Link
      to={`/tasks/${task.taskId}`}
      style={{ animationDelay: delay }}
      className="group flex animate-fade-up items-center gap-4 hover:bg-surface-2"
    >
      <span className="w-32 shrink-0 font-mono text-micro tracking-wideish text-muted-2">
        {task.taskId}
      </span>
      <span className="w-24 shrink-0 font-mono text-micro uppercase tracking-wideish text-muted">
        {task.taskSection.replace(" — not yet archived", "")}
      </span>
      <span className="flex-1 truncate font-sans text-small text-fg group-hover:text-accent">
        {task.taskTitle || <em className="text-muted">untitled task</em>}
      </span>
      <div className="flex w-[120px] items-center gap-1">
        {runs.slice(-6).map((r) => (
          <StatusDot key={r.sessionId} status={r.status} size="xs" />
        ))}
        {liveRuns > 0 && (
          <span className="font-mono text-[10px] text-status-doing">
            ●{liveRuns}
          </span>
        )}
      </div>
      <span className="w-16 shrink-0 truncate text-right font-mono text-micro text-muted-2">
        {task.taskApp ?? "—"}
      </span>
      <span className="w-12 shrink-0 text-right font-mono text-micro tabular-nums text-muted-2">
        {relTime(task.createdAt)}
      </span>
      <span onClick={(e) => e.preventDefault()}>
        <ArchiveCheckbox task={task} />
      </span>
    </Link>
  );
}

