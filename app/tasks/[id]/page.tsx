"use client";

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { ArrowLeft, Hash } from "lucide-react";
import { api } from "@/lib/client/api";
import type { Meta, Repo, Run, Task } from "@/lib/client/types";
import { HeaderShell } from "@/app/_components/HeaderShell";
import { TaskDetail } from "@/app/_components/TaskDetail";
import { SessionLog } from "@/app/_components/SessionLog";
import { useToast } from "@/app/_components/Toasts";
import { useConfirm } from "@/app/_components/ConfirmProvider";
import { Button } from "@/app/_components/ui/button";

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

  // Active run is reconstructed from the URL (`?sid=…`) so reloading or
  // sharing the URL keeps the same chat selected. It also cooperates
  // with deep-links from /sessions which already set ?sid=… for us.
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

  const setActiveRun = useCallback((run: ActiveRun | null) => {
    const params = new URLSearchParams(Array.from(search.entries()));
    if (run) params.set("sid", run.sessionId);
    else params.delete("sid");
    const qs = params.toString();
    router.replace(qs ? `/tasks/${id}?${qs}` : `/tasks/${id}`, { scroll: false });
  }, [id, router, search]);

  const saveRef = useRef<(() => void) | null>(null);

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
    refreshTask();
  }, [refreshTask]);

  // Visibility-paused meta polling, mirrors the pattern in app/page.tsx.
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
      /* 404 ok until meta.json exists */
    }
  }, [id]);

  useEffect(() => {
    if (!visible || !id) return;
    // Initial fetch and slow polling fallback (5s) — the SSE stream
    // below should drive the bulk of updates, but Next dev-server HMR
    // tends to drop SSE connections, so we keep a low-frequency
    // polling safety net to recover from a missed event.
    loadMeta();
    const h = setInterval(loadMeta, 5000);

    // Lifecycle SSE: on `snapshot` we hydrate meta directly (no extra
    // HTTP round-trip on mount); on every other event we re-fetch meta
    // so the run we just rendered is the same shape as a polled meta.
    const url = `/api/tasks/${encodeURIComponent(id)}/events`;
    const es = new EventSource(url);
    es.addEventListener("snapshot", (ev: MessageEvent) => {
      try {
        const data = JSON.parse(ev.data) as Meta;
        setMeta(data);
      } catch { /* ignore */ }
    });
    const refetch = () => { void loadMeta(); };
    es.addEventListener("spawned", refetch);
    es.addEventListener("done", refetch);
    es.addEventListener("failed", refetch);
    es.addEventListener("stale", refetch);
    es.addEventListener("updated", refetch);
    es.addEventListener("meta", (ev: MessageEvent) => {
      try {
        const data = JSON.parse(ev.data) as Meta;
        setMeta(data);
      } catch { /* ignore */ }
    });
    es.onerror = () => { /* browser auto-retries; polling fallback covers gaps */ };

    return () => {
      clearInterval(h);
      es.close();
    };
  }, [visible, id, loadMeta]);

  // If no `?sid=` is in the URL yet, default to the coordinator's session
  // by writing it to the URL — that opens the chat panel immediately AND
  // means the selection survives a reload.
  useEffect(() => {
    if (search.get("sid") || !meta?.runs?.length) return;
    const coord = meta.runs.find((r) => r.role === "coordinator") ?? meta.runs[0];
    const repo = repos.find((r) => r.name === coord.repo);
    setActiveRun({
      sessionId: coord.sessionId,
      repoPath: repo?.path ?? "",
      role: coord.role,
      repo: coord.repo,
    });
  }, [meta?.runs, repos, search, setActiveRun]);

  const handleSave = useCallback(
    async (patch: Partial<Task>) => {
      if (!id) return;
      await api.updateTask(id, patch);
      await refreshTask();
    },
    [id, refreshTask],
  );

  const handleDelete = useCallback(async () => {
    if (!id || !task) return;
    const runCount = meta?.runs.length ?? 0;
    const sessionsLine = runCount > 0
      ? `Also removes ${runCount} linked Claude session${runCount === 1 ? "" : "s"} from ~/.claude/projects/.`
      : `Also removes sessions/${id}/ metadata.`;
    const ok = await confirm({
      title: `Delete task ${id}?`,
      description: `"${task.title}"\n\n${sessionsLine}`,
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
  }, [id, task, meta, router, toast, confirm]);

  const handleSelectRun = useCallback(
    (run: Run) => {
      const repo = repos.find((r) => r.name === run.repo);
      setActiveRun({
        sessionId: run.sessionId,
        repoPath: repo?.path ?? "",
        role: run.role,
        repo: run.repo,
      });
    },
    [repos, setActiveRun],
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
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === "s") {
        e.preventDefault();
        saveRef.current?.();
        return;
      }
      if (e.key === "Escape" && !isTextInput(e.target)) {
        e.preventDefault();
        router.push("/");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [router]);

  if (loading) {
    return (
      <div className="flex flex-col h-screen items-center justify-center text-fg-dim text-sm">
        Loading task…
      </div>
    );
  }

  if (!task) {
    return (
      <div className="flex flex-col h-screen items-center justify-center text-fg-dim text-sm">
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

  return (
    <div className="flex flex-col h-screen">
      <HeaderShell active="tasks">
        <div className="flex-1 min-w-0 flex items-center gap-2">
          <span className="font-mono text-xs text-fg-dim shrink-0">{task.id}</span>
          <span className="text-fg-dim shrink-0">·</span>
          <span className="text-sm font-medium truncate">{task.title}</span>
        </div>

        <div className="ml-auto flex items-center gap-2 shrink-0">
          <kbd className="text-[10px] font-mono text-fg-dim px-1.5 py-0.5 rounded border border-border">
            ⌘S save
          </kbd>
          <kbd className="text-[10px] font-mono text-fg-dim px-1.5 py-0.5 rounded border border-border">
            Esc back
          </kbd>
        </div>
      </HeaderShell>

      <main className="flex-1 flex flex-col lg:flex-row min-h-0">
        <div className="lg:flex-1 lg:min-w-0 lg:max-w-2xl xl:max-w-3xl border-b lg:border-b-0 lg:border-r border-border flex max-h-[40vh] lg:max-h-none">
          <TaskDetail
            task={task}
            meta={meta}
            repos={repos}
            activeRunId={activeRun?.sessionId ?? null}
            onSave={handleSave}
            onDelete={handleDelete}
            onSelectRun={handleSelectRun}
            saveRef={saveRef}
          />
        </div>
        <div className="flex-1 min-w-0 min-h-0 flex">
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
    <Suspense fallback={<div className="p-6 text-sm text-muted-foreground">Loading…</div>}>
      <TaskPageInner />
    </Suspense>
  );
}
