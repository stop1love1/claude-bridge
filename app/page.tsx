"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { api } from "@/lib/client/api";
import {
  type App,
  type Meta,
  type SessionSummary,
  type Task,
} from "@/lib/client/types";
import { NewTaskDialog } from "./_components/NewTaskDialog";
import { TaskGrid } from "./_components/TaskGrid";
import { CommandPalette } from "./_components/CommandPalette";
import { useToast } from "./_components/Toasts";
import { useConfirm } from "./_components/ConfirmProvider";
import { LayoutGrid, Terminal } from "lucide-react";

function Dashboard() {
  const router = useRouter();
  const [tasks, setTasks] = useState<Task[]>([]);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [apps, setApps] = useState<App[]>([]);
  const [appFilter, setAppFilter] = useState<string>("__all__");
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
    try { setApps(await api.apps()); }
    catch { /* registry may not exist yet — ignore */ }
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

  useEffect(() => { refreshTasks(); }, [refreshTasks]);
  useEffect(() => { refreshApps(); }, [refreshApps]);

  useEffect(() => {
    if (!visible) return;
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
    refreshAllMeta();
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
    if (paletteOpen) refreshSessions();
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

  useEffect(() => {
    const isTextInput = (el: EventTarget | null) => {
      if (!(el instanceof HTMLElement)) return false;
      const tag = el.tagName;
      return tag === "INPUT" || tag === "TEXTAREA" || el.isContentEditable;
    };
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === "k") { e.preventDefault(); setPaletteOpen(true); return; }
      if (mod && e.key.toLowerCase() === "n") { e.preventDefault(); newDialogRef.current?.(); return; }
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
      <header className="h-11 shrink-0 px-3 border-b border-border bg-card flex items-center gap-3">
        <div className="flex items-center gap-2">
          <Image
            src="/logo.jpg"
            alt="Claude Bridge"
            width={20}
            height={20}
            className="rounded-sm"
            priority
          />
          <h1 className="text-sm font-semibold">Claude Bridge</h1>
        </div>

        <nav className="flex items-center bg-secondary rounded-md p-0.5 border border-border">
          <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded text-xs bg-accent text-foreground">
            <LayoutGrid size={12} /> Tasks
          </span>
          <Link
            href="/sessions"
            className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded text-xs text-muted-foreground hover:text-foreground"
          >
            <Terminal size={12} /> Sessions
            {orphanCount > 0 && (
              <span className="ml-1 px-1 rounded bg-warning/20 text-warning text-[9px] tabular-nums">
                {orphanCount}
              </span>
            )}
          </Link>
        </nav>

        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search tasks"
          className="flex-1 max-w-sm bg-background border border-border rounded-md px-3 py-1 text-xs focus:outline-none focus:border-primary"
        />

        <select
          value={appFilter}
          onChange={(e) => setAppFilter(e.target.value)}
          className="bg-background border border-border rounded-md px-2 py-1 text-xs focus:outline-none focus:border-primary"
          title="Filter tasks by target app"
        >
          <option value="__all__">All apps</option>
          <option value="__auto__">Auto (no app set)</option>
          {apps.map((a) => (
            <option key={a.name} value={a.name}>{a.name}</option>
          ))}
        </select>

        <div className="ml-auto flex items-center gap-2">
          {runningCount > 0 && (
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-warning/15 text-warning text-[11px] font-medium">
              <span className="relative inline-flex h-1.5 w-1.5">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-warning opacity-60" />
                <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-warning" />
              </span>
              {runningCount}
            </span>
          )}
          <button
            onClick={() => setPaletteOpen(true)}
            className="text-[10px] font-mono text-fg-dim hover:text-foreground px-1.5 py-0.5 rounded border border-border"
            title="Command palette"
          >
            ⌘K
          </button>
          <NewTaskDialog apps={apps} onCreate={handleCreate} openRef={newDialogRef} />
        </div>
      </header>

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
  return <Dashboard />;
}
