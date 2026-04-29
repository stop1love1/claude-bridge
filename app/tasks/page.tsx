"use client";

import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { api } from "@/libs/client/api";
import {
  type App,
  type Meta,
  type Repo,
  type SessionSummary,
  type Task,
} from "@/libs/client/types";
import { HeaderShell } from "../_components/HeaderShell";
import { NewTaskDialog } from "../_components/NewTaskDialog";
import { TaskGrid } from "../_components/TaskGrid";
import { CommandPalette } from "../_components/CommandPalette";
import { Button } from "../_components/ui/button";
import { Input } from "../_components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../_components/ui/select";
import { useToast } from "../_components/Toasts";
import { useConfirm } from "../_components/ConfirmProvider";

function Dashboard() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const appFilter = searchParams.get("app") ?? "__all__";
  const setAppFilter = useCallback(
    (v: string) => {
      const params = new URLSearchParams(searchParams.toString());
      if (v === "__all__") params.delete("app");
      else params.set("app", v);
      const qs = params.toString();
      router.replace(qs ? `/tasks?${qs}` : "/tasks");
    },
    [router, searchParams],
  );
  const [tasks, setTasks] = useState<Task[]>([]);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [apps, setApps] = useState<App[]>([]);
  const [repos, setRepos] = useState<Repo[]>([]);
  const [query, setQuery] = useState("");
  const [metaByTask, setMetaByTask] = useState<Map<string, Meta>>(new Map());
  const [paletteOpen, setPaletteOpen] = useState(false);
  const toast = useToast();
  const confirm = useConfirm();

  const newDialogRef = useRef<(() => void) | null>(null);

  const refreshTasks = useCallback(async () => {
    try { setTasks(await api.tasks()); }
    catch (e) { toast("error", (e as Error).message); }
  }, [toast]);

  const refreshApps = useCallback(async () => {
    try {
      const [a, r] = await Promise.all([api.apps(), api.repos()]);
      setApps(a);
      setRepos(r);
    } catch { /* registry may not exist yet — ignore */ }
  }, []);

  const refreshAllMeta = useCallback(async () => {
    try {
      const all = await api.allMeta();
      setMetaByTask(new Map(Object.entries(all)));
    } catch { /* ignore transient */ }
  }, []);

  // Sessions are only loaded for the command palette; lazy load.
  const refreshSessions = useCallback(async () => {
    try { setSessions(await api.allSessions()); }
    catch { /* palette will show whatever it has */ }
  }, []);

  const [visible, setVisible] = useState(
    typeof document !== "undefined" ? document.visibilityState === "visible" : true,
  );
  useEffect(() => {
    const onVis = () => setVisible(document.visibilityState === "visible");
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, []);

  // Mount-time fetches are deferred to a microtask so the setState
  // calls inside `refreshTasks` / `refreshApps` happen *after* the
  // effect body returns, satisfying `react-hooks/set-state-in-effect`.
  useEffect(() => { void Promise.resolve().then(refreshTasks); }, [refreshTasks]);
  useEffect(() => { void Promise.resolve().then(refreshApps); }, [refreshApps]);

  useEffect(() => {
    if (!visible) return;
    // Fire immediately on tab-becomes-visible so a user returning after
    // 5+ minutes sees fresh data instead of waiting for the next tick.
    void Promise.resolve().then(refreshTasks);
    const h = setInterval(refreshTasks, 15_000);
    return () => clearInterval(h);
  }, [visible, refreshTasks]);

  // Meta poll cadence: fast when at least one task is `running` (live
  // status pill matters), slow otherwise. The TaskDetail page has its
  // own per-task SSE so it doesn't depend on this for live updates.
  //
  // We deliberately do NOT depend on `metaByTask` here — that would
  // re-run the effect every time `refreshAllMeta` lands new data,
  // which would clear+recreate the interval AND re-fire the immediate
  // `refreshAllMeta()` call at the top of the effect. A ref lets each
  // tick read the latest "any running?" state without forcing a
  // dependency on the changing data.
  const metaByTaskRef = useRef(metaByTask);
  useEffect(() => { metaByTaskRef.current = metaByTask; }, [metaByTask]);

  useEffect(() => {
    if (!visible || tasks.length === 0) return;
    void Promise.resolve().then(refreshAllMeta);
    const tick = () => {
      const anyRunning = Array.from(metaByTaskRef.current.values()).some((m) =>
        m.runs.some((r) => r.status === "running"),
      );
      refreshAllMeta();
      schedule(anyRunning ? 4_000 : 12_000);
    };
    let h: ReturnType<typeof setTimeout> | null = null;
    const schedule = (delay: number) => {
      if (h) clearTimeout(h);
      h = setTimeout(tick, delay);
    };
    schedule(4_000);
    return () => { if (h) clearTimeout(h); };
  }, [visible, tasks.length, refreshAllMeta]);

  // Only fetch sessions when the palette opens — saves disk scans on idle.
  useEffect(() => {
    if (paletteOpen) void Promise.resolve().then(refreshSessions);
  }, [paletteOpen, refreshSessions]);

  const openTask = useCallback(
    (id: string) => router.push(`/tasks/${id}`),
    [router],
  );

  const handleCreate = async ({ body, app }: { body: string; app: string | null }) => {
    try {
      const t = await api.createTask({ body, app });
      await refreshTasks();
      toast("success", `Created ${t.id}`);
      router.push(`/tasks/${t.id}`);
    } catch (e) { toast("error", (e as Error).message); throw e; }
  };

  const handleQuickAdd = async (body: string) => {
    try {
      const t = await api.createTask({ body });
      await refreshTasks();
      toast("success", `Created ${t.id}`);
    } catch (e) { toast("error", (e as Error).message); }
  };

  const handleDeleteTask = async (id: string) => {
    const t = tasks.find((x) => x.id === id);
    const m = metaByTask.get(id);
    const runCount = m?.runs.length ?? 0;
    const sessionsLine = runCount > 0
      ? `Also removes ${runCount} linked Claude session${runCount === 1 ? "" : "s"} from ~/.claude/projects/.`
      : "Also removes sessions/" + id + "/ metadata.";
    const ok = await confirm({
      title: `Delete task ${id}?`,
      description: t ? `"${t.title}"\n\n${sessionsLine}` : sessionsLine,
      confirmLabel: "Delete",
      destructive: true,
    });
    if (!ok) return;
    try {
      const r = await api.deleteTask(id);
      await refreshTasks();
      await refreshAllMeta();
      const msg = r.sessionsDeleted > 0
        ? `Task deleted (${r.sessionsDeleted} session${r.sessionsDeleted === 1 ? "" : "s"} removed${r.sessionsFailed ? `, ${r.sessionsFailed} failed` : ""})`
        : "Task deleted";
      toast(r.sessionsFailed > 0 ? "error" : "info", msg);
    } catch (e) { toast("error", (e as Error).message); }
  };

  const handleSelectSession = (s: SessionSummary) => {
    if (s.link) router.push(`/tasks/${s.link.taskId}`);
    else router.push("/sessions");
  };

  const handleBulkDelete = useCallback(async (ids: string[]) => {
    const ok = await confirm({
      title: `Delete ${ids.length} task${ids.length === 1 ? "" : "s"}?`,
      description: `This also removes per-task sessions/<id>/ metadata and any linked Claude sessions.`,
      confirmLabel: "Delete all",
      destructive: true,
    });
    if (!ok) return;
    let removed = 0;
    let failed = 0;
    for (const id of ids) {
      try { await api.deleteTask(id); removed += 1; }
      catch { failed += 1; }
    }
    await refreshTasks();
    await refreshAllMeta();
    toast(failed > 0 ? "error" : "info",
      `${removed} deleted${failed ? `, ${failed} failed` : ""}`);
  }, [confirm, refreshTasks, refreshAllMeta, toast]);

  const handleMoveTask = useCallback(
    async (id: string, section: import("@/libs/client/types").TaskSection) => {
      // Optimistic update so the card visibly snaps into the new column
      // before the network round-trip lands; refreshTasks() reconciles
      // a few hundred ms later.
      setTasks((prev) =>
        prev.map((t) =>
          t.id === id
            ? {
                ...t,
                section,
                checked: section === "DONE — not yet archived",
              }
            : t,
        ),
      );
      try {
        await api.updateTask(id, {
          section,
          checked: section === "DONE — not yet archived",
        });
        await refreshTasks();
        await refreshAllMeta();
      } catch (e) {
        // Roll back by re-fetching the canonical state.
        await refreshTasks();
        toast("error", (e as Error).message);
      }
    },
    [refreshTasks, refreshAllMeta, toast],
  );

  const handleBulkMove = useCallback(async (ids: string[], section: import("@/libs/client/types").TaskSection) => {
    let moved = 0;
    let failed = 0;
    for (const id of ids) {
      try {
        await api.updateTask(id, {
          section,
          checked: section === "DONE — not yet archived",
        });
        moved += 1;
      } catch {
        failed += 1;
      }
    }
    await refreshTasks();
    await refreshAllMeta();
    toast(failed > 0 ? "error" : "info",
      `${moved} moved to ${section}${failed ? `, ${failed} failed` : ""}`);
  }, [refreshTasks, refreshAllMeta, toast]);

  useEffect(() => {
    const isTextInput = (el: EventTarget | null) => {
      if (!(el instanceof HTMLElement)) return false;
      const tag = el.tagName;
      return tag === "INPUT" || tag === "TEXTAREA" || el.isContentEditable;
    };
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === "k") {
        if (isTextInput(e.target)) return;
        e.preventDefault();
        setPaletteOpen(true);
        return;
      }
      if (mod && e.key.toLowerCase() === "n") {
        if (isTextInput(e.target)) return;
        e.preventDefault();
        newDialogRef.current?.();
        return;
      }
      if (!isTextInput(e.target) && !paletteOpen && e.key === "/") {
        e.preventDefault();
        document.querySelector<HTMLInputElement>('input[type="search"]')?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [paletteOpen]);

  const runningCount = Array.from(metaByTask.values())
    .reduce((acc, m) => acc + m.runs.filter((r) => r.status === "running").length, 0);
  const orphanCount = sessions.filter((s) => !s.link).length;

  return (
    <div className="flex flex-col h-screen">
      <HeaderShell
        active="tasks"
        badges={{
          sessions: orphanCount > 0 ? (
            <span className="ml-1 px-1 rounded bg-warning/20 text-warning text-[9px] tabular-nums">
              {orphanCount}
            </span>
          ) : undefined,
        }}
      />

      {/* Page sub-toolbar — search, filter, and CTAs that used to live
          in the global header. Wraps to a second row on narrow viewports
          so nothing gets pushed off-screen. */}
      <div className="shrink-0 px-2 sm:px-3 py-2 border-b border-border bg-background flex items-center gap-1.5 sm:gap-2 flex-wrap">
        <Input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search tasks"
          className="flex-1 min-w-[120px] max-w-sm h-7 text-xs"
        />
        <Select value={appFilter} onValueChange={setAppFilter}>
          <SelectTrigger
            className="h-7 px-2 text-xs gap-1 [&>span]:truncate w-[110px] sm:w-[150px]"
            title="Filter tasks by target app"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="__all__">All apps</SelectItem>
            <SelectItem value="__auto__">Auto (no app set)</SelectItem>
            {apps.map((a) => (
              <SelectItem key={a.name} value={a.name}>{a.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <div className="flex-1" />
        {runningCount > 0 && (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-warning/15 text-warning text-[11px] font-medium">
            <span className="relative inline-flex h-1.5 w-1.5">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-warning opacity-60" />
              <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-warning" />
            </span>
            {runningCount}
          </span>
        )}
        <Button
          onClick={() => setPaletteOpen(true)}
          variant="outline"
          size="xs"
          title="Command palette"
          className="hidden md:inline-flex font-mono text-[10px] text-fg-dim"
        >
          ⌘K
        </Button>
        <NewTaskDialog apps={apps} repos={repos} onCreate={handleCreate} openRef={newDialogRef} />
      </div>

      <main className="flex-1 flex min-h-0">
        <TaskGrid
          tasks={tasks.filter((t) => {
            if (appFilter === "__all__") return true;
            if (appFilter === "__auto__") return !t.app;
            return t.app === appFilter;
          })}
          metaByTask={metaByTask}
          activeTaskId={null}
          query={query}
          onOpenTask={openTask}
          onQuickAdd={handleQuickAdd}
          onDeleteTask={handleDeleteTask}
          onBulkDelete={handleBulkDelete}
          onBulkMove={handleBulkMove}
          onMoveTask={handleMoveTask}
        />
      </main>

      <CommandPalette
        open={paletteOpen}
        tasks={tasks}
        sessions={sessions}
        onClose={() => setPaletteOpen(false)}
        onOpenTask={openTask}
        onCreateTask={() => newDialogRef.current?.()}
        onNavigate={(p) => router.push(p)}
        onSelectSession={handleSelectSession}
      />
    </div>
  );
}

export default function Page() {
  return (
    <Suspense fallback={<div className="p-6 space-y-3"><div className="h-4 w-32 rounded bg-muted/60 animate-pulse" /><div className="h-3 w-2/3 rounded bg-muted/60 animate-pulse" /></div>}>
      <Dashboard />
    </Suspense>
  );
}
