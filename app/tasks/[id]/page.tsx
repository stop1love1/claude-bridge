"use client";

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { ArrowLeft, Hash } from "lucide-react";
import { api } from "@/libs/client/api";
import type { Meta, Repo, Run, Task } from "@/libs/client/types";
import { SECTION_DOING, SECTION_DONE } from "@/libs/tasks";
import { HeaderShell } from "@/app/_components/HeaderShell";
import { PresenceBadge } from "@/app/_components/PresenceBadge";
import { TaskDetail } from "@/app/_components/TaskDetail";
import { SessionLog } from "@/app/_components/SessionLog";
import { useToast } from "@/app/_components/Toasts";
import { useConfirm } from "@/app/_components/ConfirmProvider";
import { useEventSource } from "@/app/_components/useEventSource";

type ActiveRun = {
  sessionId: string;
  repoPath: string;
  role: string;
  repo: string;
};

function TaskPageInner() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const search = useSearchParams();
  const toast = useToast();
  const confirm = useConfirm();

  const [task, setTask] = useState<Task | null>(null);
  const [meta, setMeta] = useState<Meta | null>(null);
  const [repos, setRepos] = useState<Repo[]>([]);
  const [loading, setLoading] = useState(true);
  const [liveStatusBySession, setLiveStatusBySession] = useState<
    Map<string, { kind: string; label?: string }>
  >(new Map());
  const [mobileTab, setMobileTab] = useState<"detail" | "chat">(() => {
    const urlTab = search.get("activeTab");
    if (urlTab === "detail" || urlTab === "chat") return urlTab;
    return search.get("sid") ? "chat" : "detail";
  });

  const activeRun = useMemo<ActiveRun | null>(() => {
    const sid = search.get("sid");
    if (!sid || !meta?.runs?.length) return null;
    const run = meta.runs.find((r) => r.sessionId === sid);
    if (!run) return null;
    const repo = repos.find((r) => r.name === run.repo);
    return {
      sessionId: run.sessionId,
      repoPath: repo?.path ?? "",
      role: run.role,
      repo: run.repo,
    };
  }, [search, meta, repos]);

  const resolvedTask = useMemo((): Task | null => {
    if (!task) return null;
    if (!meta || meta.taskId !== task.id) return task;
    return {
      ...task,
      title: meta.taskTitle,
      body: meta.taskBody,
      status: meta.taskStatus,
      section: meta.taskSection,
      checked: meta.taskChecked,
    };
  }, [task, meta]);

  const setActiveRun = useCallback((run: ActiveRun | null) => {
    const params = new URLSearchParams(Array.from(search.entries()));
    if (run) params.set("sid", run.sessionId);
    else params.delete("sid");
    const qs = params.toString();
    router.replace(qs ? `/tasks/${id}?${qs}` : `/tasks/${id}`, { scroll: false });
  }, [id, router, search]);

  const setMobileTabWithUrl = useCallback((tab: "detail" | "chat") => {
    setMobileTab(tab);
    const params = new URLSearchParams(Array.from(search.entries()));
    if (tab === "detail") params.delete("activeTab");
    else params.set("activeTab", tab);
    const qs = params.toString();
    router.replace(qs ? `/tasks/${id}?${qs}` : `/tasks/${id}`, { scroll: false });
  }, [id, router, search]);

  const refreshTask = useCallback(async () => {
    try {
      const all = await api.tasks();
      const found = all.find((t) => t.id === id) ?? null;
      setTask(found);
    } catch (e) {
      toast("error", (e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [id, toast]);

  useEffect(() => {
    api.repos().then(setRepos).catch(() => {});
    void Promise.resolve().then(refreshTask);
  }, [refreshTask]);

  const [visible, setVisible] = useState(
    typeof document !== "undefined" ? document.visibilityState === "visible" : true,
  );
  useEffect(() => {
    const onVis = () => setVisible(document.visibilityState === "visible");
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, []);

  const loadMeta = useCallback(async () => {
    if (!id) return;
    try {
      const m = await api.meta(id);
      setMeta(m);
    } catch {
    }
  }, [id]);

  useEffect(() => {
    if (!visible || !id) return;
    void Promise.resolve().then(loadMeta);
    void Promise.resolve().then(refreshTask);
    const h = setInterval(loadMeta, 30000);
    return () => clearInterval(h);
  }, [visible, id, loadMeta, refreshTask]);

  const applyMetaFromEvent = useCallback((ev: MessageEvent) => {
    try {
      const data = JSON.parse(ev.data) as { meta?: Meta };
      if (data.meta) setMeta(data.meta);
      else void loadMeta();
    } catch { }
  }, [loadMeta]);
  const applySnapshotFromEvent = useCallback((ev: MessageEvent) => {
    try {
      setMeta(JSON.parse(ev.data) as Meta);
    } catch { }
  }, []);
  const applyChildStatus = useCallback((ev: MessageEvent) => {
    try {
      const data = JSON.parse(ev.data) as {
        sessionId: string;
        status: { kind: string; label?: string };
      };
      setLiveStatusBySession((prev) => {
        const next = new Map(prev);
        if (data.status.kind === "idle") next.delete(data.sessionId);
        else next.set(data.sessionId, data.status);
        return next;
      });
    } catch { }
  }, []);
  const applyChildAlive = useCallback((ev: MessageEvent) => {
    try {
      const data = JSON.parse(ev.data) as { sessionId: string; alive: boolean };
      if (!data.alive) {
        setLiveStatusBySession((prev) => {
          if (!prev.has(data.sessionId)) return prev;
          const next = new Map(prev);
          next.delete(data.sessionId);
          return next;
        });
      }
    } catch { }
  }, []);
  const eventListeners = useMemo(
    () => ({
      snapshot: applySnapshotFromEvent,
      meta: applySnapshotFromEvent,
      spawned: applyMetaFromEvent,
      done: applyMetaFromEvent,
      failed: applyMetaFromEvent,
      cancelled: applyMetaFromEvent,
      stale: applyMetaFromEvent,
      updated: applyMetaFromEvent,
      retried: applyMetaFromEvent,
      "child-status": applyChildStatus,
      "child-alive": applyChildAlive,
    }),
    [applyMetaFromEvent, applySnapshotFromEvent, applyChildStatus, applyChildAlive],
  );
  useEventSource(
    visible && id ? `/api/tasks/${encodeURIComponent(id)}/events` : null,
    { listeners: eventListeners },
  );

  const autoSelectedRef = useRef(false);
  useEffect(() => {
    if (autoSelectedRef.current) return;
    if (search.get("sid") || !meta?.runs?.length) return;
    autoSelectedRef.current = true;
    const coord = meta.runs.find((r) => r.role === "coordinator") ?? meta.runs[0];
    const repo = repos.find((r) => r.name === coord.repo);
    setActiveRun({
      sessionId: coord.sessionId,
      repoPath: repo?.path ?? "",
      role: coord.role,
      repo: coord.repo,
    });
  }, [meta?.runs, repos, search, setActiveRun]);

  useEffect(() => {
    const urlTab = search.get("activeTab");
    const nextTab: "detail" | "chat" = urlTab === "chat" ? "chat" : "detail";
    void Promise.resolve().then(() => {
      setMobileTab((prev) => (prev !== nextTab ? nextTab : prev));
    });
  }, [search]);

  const handleToggleComplete = useCallback(
    async (next: boolean) => {
      if (!id) return;
      await api.updateTask(id, {
        checked: next,
        section: next ? SECTION_DONE : SECTION_DOING,
      });
      await refreshTask();
    },
    [id, refreshTask],
  );

  const handleDelete = useCallback(async () => {
    if (!id || !resolvedTask) return;
    const runCount = meta?.runs.length ?? 0;
    const sessionsLine = runCount > 0
      ? `Also removes ${runCount} linked Claude session${runCount === 1 ? "" : "s"} from ~/.claude/projects/.`
      : `Also removes sessions/${id}/ metadata.`;
    const ok = await confirm({
      title: `Delete task ${id}?`,
      description: `"${resolvedTask.title}"\n\n${sessionsLine}`,
      confirmLabel: "Delete",
      destructive: true,
    });
    if (!ok) return;
    try {
      const r = await api.deleteTask(id);
      const msg = r.sessionsDeleted > 0
        ? `Task deleted (${r.sessionsDeleted} session${r.sessionsDeleted === 1 ? "" : "s"} removed${r.sessionsFailed ? `, ${r.sessionsFailed} failed` : ""})`
        : "Task deleted";
      toast(r.sessionsFailed > 0 ? "error" : "info", msg);
      router.push("/");
    } catch (e) {
      toast("error", (e as Error).message);
    }
  }, [id, resolvedTask, meta, router, toast, confirm]);

  const handleSelectRun = useCallback(
    (run: Run) => {
      setMobileTab("chat");
      const params = new URLSearchParams(Array.from(search.entries()));
      params.set("sid", run.sessionId);
      params.set("activeTab", "chat");
      const qs = params.toString();
      router.replace(qs ? `/tasks/${id}?${qs}` : `/tasks/${id}`, { scroll: false });
    },
    [id, router, search],
  );

  const handleClearConversation = useCallback(async () => {
    if (!id) return;
    const ok = await confirm({
      title: "Spawn a fresh coordinator?",
      description: "The current run is kept in history; a brand-new session takes over as the active conversation.",
      confirmLabel: "Spawn new",
    });
    if (!ok) return;
    try {
      const r = await api.clearTask(id);
      toast("success", "Spawned new coordinator");
      setActiveRun(null);
      void r;
      await loadMeta();
    } catch (e) {
      toast("error", (e as Error).message);
    }
  }, [id, toast, loadMeta, confirm, setActiveRun]);

  useEffect(() => {
    const isTextInput = (el: EventTarget | null) => {
      if (!(el instanceof HTMLElement)) return false;
      const tag = el.tagName;
      return tag === "INPUT" || tag === "TEXTAREA" || el.isContentEditable;
    };
    const overlayOpen = () =>
      typeof document !== "undefined" &&
      !!document.querySelector(
        '[data-radix-popper-content-wrapper], [role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"]',
      );
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !isTextInput(e.target) && !overlayOpen()) {
        e.preventDefault();
        router.push("/tasks");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [router]);

  if (loading) {
    return (
      <div className="flex flex-col h-dvh overflow-hidden">
        <div className="h-11 shrink-0 border-b border-border bg-card" />
        <div className="flex-1 p-6 max-w-3xl mx-auto w-full space-y-3">
          <div className="h-3 w-32 rounded bg-muted/60 animate-pulse" />
          <div className="h-6 w-2/3 rounded bg-muted/60 animate-pulse" />
          <div className="h-4 w-full rounded bg-muted/60 animate-pulse" />
          <div className="h-4 w-5/6 rounded bg-muted/60 animate-pulse" />
          <div className="mt-8 h-10 w-full rounded bg-muted/60 animate-pulse" />
        </div>
      </div>
    );
  }

  if (!task) {
    return (
      <div className="flex flex-col h-dvh overflow-hidden items-center justify-center text-fg-dim text-sm">
        <Hash size={32} className="mb-3 opacity-30" />
        <p className="mb-1 text-foreground">Task not found</p>
        <p className="text-xs text-fg-dim/70 mb-4 font-mono">{id}</p>
        <button
          onClick={() => router.push("/")}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-secondary border border-border hover:bg-accent text-sm"
        >
          <ArrowLeft size={14} /> Back
        </button>
      </div>
    );
  }

  const headerTask = resolvedTask ?? task;

  return (
    <div className="flex flex-col h-dvh overflow-hidden">
      <HeaderShell active="tasks" />

      {}
      <div className="shrink-0 px-3 py-2 border-b border-border bg-background flex items-center gap-2 min-w-0">
        <button
          type="button"
          onClick={() => router.push("/tasks")}
          className="sm:hidden inline-flex items-center justify-center h-7 w-7 -ml-1 rounded-md text-fg-dim hover:text-foreground hover:bg-accent shrink-0"
          aria-label="Back to tasks"
          title="Back to tasks"
        >
          <ArrowLeft size={14} />
        </button>
        <span className="hidden sm:inline text-fg-dim shrink-0">/</span>
        <span className="hidden sm:inline font-mono text-xs text-fg-dim shrink-0">{headerTask.id}</span>
        <span className="hidden sm:inline text-fg-dim shrink-0">·</span>
        <span className="text-[13px] sm:text-sm font-medium truncate flex-1 min-w-0">{headerTask.title}</span>
        <PresenceBadge taskId={id} />
        <kbd className="hidden md:inline-flex items-center text-[10px] font-mono text-fg-dim px-1.5 py-0.5 rounded border border-border shrink-0">
          Esc back
        </kbd>
      </div>

      {}
      <div className="md:hidden shrink-0 flex border-b border-border bg-card">
        <button
          type="button"
          onClick={() => setMobileTabWithUrl("detail")}
          aria-pressed={mobileTab === "detail"}
          className={`flex-1 py-1.5 text-[11.5px] font-medium border-b-2 transition-colors ${
            mobileTab === "detail"
              ? "border-primary text-foreground"
              : "border-transparent text-muted-foreground hover:text-foreground"
          }`}
        >
          Detail
        </button>
        <button
          type="button"
          onClick={() => setMobileTabWithUrl("chat")}
          aria-pressed={mobileTab === "chat"}
          className={`flex-1 py-1.5 text-[11.5px] font-medium border-b-2 transition-colors truncate px-2 ${
            mobileTab === "chat"
              ? "border-primary text-foreground"
              : "border-transparent text-muted-foreground hover:text-foreground"
          }`}
        >
          Chat{activeRun ? ` · ${activeRun.role}` : ""}
        </button>
      </div>

      <main className="flex-1 flex flex-col md:flex-row min-h-0 overflow-hidden">
        {}
        <div
          className={`flex-1 min-h-0 md:flex md:flex-1 md:min-w-0 md:max-w-md lg:max-w-2xl xl:max-w-3xl md:border-r border-border ${
            mobileTab === "detail" ? "flex" : "hidden"
          }`}
        >
          <TaskDetail
            task={resolvedTask}
            meta={meta}
            repos={repos}
            activeRunId={activeRun?.sessionId ?? null}
            onDelete={handleDelete}
            onSelectRun={handleSelectRun}
            onToggleComplete={handleToggleComplete}
            liveStatusBySession={liveStatusBySession}
          />
        </div>
        <div
          className={`flex-1 min-w-0 min-h-0 md:flex ${
            mobileTab === "chat" ? "flex" : "hidden"
          }`}
        >
          <SessionLog
            run={activeRun}
            repos={repos}
            taskId={id}
            onClearConversation={handleClearConversation}
          />
        </div>
      </main>
    </div>
  );
}

export default function TaskPage() {
  return (
    <Suspense fallback={<div className="p-6 space-y-3"><div className="h-4 w-32 rounded bg-muted/60 animate-pulse" /><div className="h-3 w-2/3 rounded bg-muted/60 animate-pulse" /></div>}>
      <TaskPageInner />
    </Suspense>
  );
}
