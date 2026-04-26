"use client";

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { PanelLeftClose, PanelLeftOpen } from "lucide-react";
import { api } from "@/lib/client/api";
import type { Repo, SessionSummary, Task } from "@/lib/client/types";
import { HeaderShell } from "../_components/HeaderShell";
import { SessionLog } from "../_components/SessionLog";
import { SessionsBrowser } from "../_components/SessionsBrowser";
import { LinkSessionDialog } from "../_components/LinkSessionDialog";
import { NewSessionDialog } from "../_components/NewSessionDialog";
import { useToast } from "../_components/Toasts";
import { useConfirm } from "../_components/ConfirmProvider";
import { Button } from "../_components/ui/button";
import { Badge } from "../_components/ui/badge";

type ActiveRun = {
  sessionId: string;
  repoPath: string;
  role: string;
  repo: string;
};

function SessionsPageInner() {
  const router = useRouter();
  const search = useSearchParams();
  const toast = useToast();
  const confirm = useConfirm();

  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [repos, setRepos] = useState<Repo[]>([]);
  const [query, setQuery] = useState("");
  const [sidebarOpen, setSidebarOpen] = useState(true);

  const linkDialogRef = useRef<((s: SessionSummary) => void) | null>(null);
  const newSessionRef = useRef<(() => void) | null>(null);

  // The active run is reconstructed from URL params on every render so a
  // reload (or a copy-pasted URL) lands the user on the same session.
  const activeRun = useMemo<ActiveRun | null>(() => {
    const sid = search.get("sid");
    const repoName = search.get("repo");
    if (!sid || !repoName) return null;
    const repo = repos.find((r) => r.name === repoName);
    const sess = sessions.find((s) => s.sessionId === sid);
    return {
      sessionId: sid,
      repoPath: repo?.path ?? sess?.repoPath ?? "",
      role: sess?.link?.role ?? "orphan",
      repo: repoName,
    };
  }, [search, repos, sessions]);

  const setActiveRun = useCallback((run: ActiveRun | null) => {
    const params = new URLSearchParams(Array.from(search.entries()));
    if (run) {
      params.set("sid", run.sessionId);
      params.set("repo", run.repo);
    } else {
      params.delete("sid");
      params.delete("repo");
    }
    const qs = params.toString();
    router.replace(qs ? `/sessions?${qs}` : "/sessions", { scroll: false });
  }, [router, search]);

  const refreshSessions = useCallback(async () => {
    try { setSessions(await api.allSessions()); }
    catch (e) { toast("error", (e as Error).message); }
  }, [toast]);

  const [visible, setVisible] = useState(
    typeof document !== "undefined" ? document.visibilityState === "visible" : true,
  );
  useEffect(() => {
    const onVis = () => setVisible(document.visibilityState === "visible");
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, []);

  useEffect(() => {
    api.repos().then(setRepos).catch(() => {});
    api.tasks().then(setTasks).catch(() => {});
    refreshSessions();
  }, [refreshSessions]);

  useEffect(() => {
    if (!visible) return;
    // Fire immediately on tab-becomes-visible so returning users see
    // fresh data instead of waiting up to a poll interval.
    refreshSessions();
    const h = setInterval(refreshSessions, 5_000);
    return () => clearInterval(h);
  }, [visible, refreshSessions]);

  // Hide sidebar by default on small screens once we know the viewport.
  // On larger screens, restore the user's last collapsed/open preference
  // from localStorage so a refresh doesn't yank the panel back.
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 768px)");
    const SIDEBAR_KEY = "bridge.sessions.sidebarOpen";
    const apply = () => {
      if (mq.matches) {
        setSidebarOpen(false);
      } else {
        try {
          const stored = window.localStorage.getItem(SIDEBAR_KEY);
          setSidebarOpen(stored === null ? true : stored === "1");
        } catch {
          setSidebarOpen(true);
        }
      }
    };
    apply();
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, []);

  // Persist desktop sidebar preference. Skipped on mobile so toggling
  // the panel while on a phone doesn't override the desktop default.
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (window.matchMedia("(max-width: 768px)").matches) return;
    try { window.localStorage.setItem("bridge.sessions.sidebarOpen", sidebarOpen ? "1" : "0"); }
    catch { /* ignore */ }
  }, [sidebarOpen]);

  const handleSelectSession = useCallback(
    (s: SessionSummary) => {
      if (s.link) {
        router.push(`/tasks/${s.link.taskId}?sid=${s.sessionId}`);
        return;
      }
      const repo = repos.find((r) => r.name === s.repo);
      setActiveRun({
        sessionId: s.sessionId,
        repoPath: repo?.path ?? s.repoPath ?? "",
        role: "orphan",
        repo: s.repo,
      });
      // Auto-collapse sidebar on small screens after picking a session.
      if (window.matchMedia("(max-width: 768px)").matches) setSidebarOpen(false);
    },
    [repos, router, setActiveRun],
  );

  const handleLink = async (args: {
    taskId: string; sessionId: string; repo: string; role: string;
  }) => {
    try {
      await api.linkSessionToTask(args.taskId, {
        sessionId: args.sessionId, role: args.role, repo: args.repo,
      });
      toast("success", `Linked to ${args.taskId}`);
      await refreshSessions();
    } catch (e) { toast("error", (e as Error).message); throw e; }
  };

  const handleDelete = useCallback(async (s: SessionSummary) => {
    const linkedNote = s.link ? `Currently linked to ${s.link.taskId} (${s.link.role}). The link will be removed.\n\n` : "";
    const ok = await confirm({
      title: `Delete session ${s.sessionId.slice(0, 8)}…?`,
      description: `${linkedNote}The .jsonl file is removed from ~/.claude/projects/. The bridge task entry stays.`,
      confirmLabel: "Delete",
      destructive: true,
    });
    if (!ok) return;
    try {
      const r = await api.deleteSession(s.sessionId, s.repo);
      toast("info", r.fileRemoved ? "Session deleted" : "Session unlinked");
      if (activeRun?.sessionId === s.sessionId) setActiveRun(null);
      await refreshSessions();
    } catch (e) {
      toast("error", (e as Error).message);
    }
  }, [activeRun, refreshSessions, toast, confirm, setActiveRun]);

  const handleCreate = useCallback(({ repo }: { repo: string }) => {
    // Generate the session UUID client-side and jump straight into an
    // empty SessionLog. The actual `claude` spawn is deferred until
    // the user types their first message — the /api/sessions/<id>/message
    // route detects the missing .jsonl and starts a fresh session at
    // that UUID instead of resuming. No server round-trip needed here.
    const repoEntry = repos.find((x) => x.name === repo);
    if (!repoEntry) { toast("error", `unknown repo: ${repo}`); return; }
    const sessionId = (typeof crypto !== "undefined" && "randomUUID" in crypto)
      ? crypto.randomUUID()
      : `${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}`;
    setActiveRun({
      sessionId,
      repoPath: repoEntry.path,
      role: "orphan",
      repo,
    });
    if (window.matchMedia("(max-width: 768px)").matches) setSidebarOpen(false);
  }, [repos, toast, setActiveRun]);

  const orphanCount = sessions.filter((s) => !s.link).length;

  return (
    <div className="flex flex-col h-screen">
      <HeaderShell
        active="sessions"
        badges={{
          sessions: orphanCount > 0 ? (
            <Badge variant="warning" className="ml-1 px-1 py-0 text-[9px]">
              {orphanCount}
            </Badge>
          ) : undefined,
        }}
        actions={
          <>
            <span className="hidden lg:inline text-[10px] text-muted-foreground">
              {sessions.length} session{sessions.length === 1 ? "" : "s"} · {repos.length} repo{repos.length === 1 ? "" : "s"}
            </span>
            <NewSessionDialog
              repos={repos}
              defaultRepo={repos.find((r) => r.isBridge)?.name ?? repos[0]?.name}
              onCreate={handleCreate}
              openRef={newSessionRef}
            />
          </>
        }
      >
        <Button
          variant="ghost"
          size="iconSm"
          className="md:hidden"
          onClick={() => setSidebarOpen((v) => !v)}
          aria-label={sidebarOpen ? "Hide sessions" : "Show sessions"}
        >
          {sidebarOpen ? <PanelLeftClose className="h-4 w-4" /> : <PanelLeftOpen className="h-4 w-4" />}
        </Button>
      </HeaderShell>

      <main className="flex-1 flex min-h-0 relative">
        {sidebarOpen && (
          <>
            {/* Backdrop on small screens — taps it close the sidebar */}
            <button
              type="button"
              aria-label="Close sidebar"
              onClick={() => setSidebarOpen(false)}
              className="md:hidden absolute inset-0 z-10 bg-black/40 backdrop-blur-[1px]"
            />
            <div className="absolute md:static z-20 left-0 top-0 h-full md:h-auto md:flex">
              <SessionsBrowser
                sessions={sessions}
                query={query}
                activeSessionId={activeRun?.sessionId ?? null}
                onQueryChange={setQuery}
                onSelect={handleSelectSession}
                onLink={(s) => linkDialogRef.current?.(s)}
                onDelete={handleDelete}
              />
            </div>
          </>
        )}
        <div className="flex-1 min-w-0 flex">
          <SessionLog run={activeRun} repos={repos} />
        </div>
      </main>

      <LinkSessionDialog
        session={null}
        tasks={tasks}
        openRef={linkDialogRef}
        onLink={handleLink}
      />
    </div>
  );
}

export default function SessionsPage() {
  return (
    <Suspense fallback={<div className="p-6 space-y-3"><div className="h-4 w-32 rounded bg-muted/60 animate-pulse" /><div className="h-3 w-2/3 rounded bg-muted/60 animate-pulse" /></div>}>
      <SessionsPageInner />
    </Suspense>
  );
}
