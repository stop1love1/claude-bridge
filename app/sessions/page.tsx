"use client";

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { api } from "@/lib/client/api";
import type { Repo, SessionSummary } from "@/lib/client/types";
import { HeaderShell } from "../_components/HeaderShell";
import { SessionLog } from "../_components/SessionLog";
import { SessionsBrowser } from "../_components/SessionsBrowser";
import { useToast } from "../_components/Toasts";
import { useConfirm } from "../_components/ConfirmProvider";
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
  const [repos, setRepos] = useState<Repo[]>([]);
  const [query, setQuery] = useState("");
  // Mobile (< md) shows ONE pane at a time via the tab bar — same UX
  // as task-detail. Desktop keeps both panes side-by-side, so this
  // only matters on phones.
  const [mobileTab, setMobileTab] = useState<"browser" | "chat">(() => {
    if (typeof window === "undefined") return "browser";
    return new URLSearchParams(window.location.search).get("sid") ? "chat" : "browser";
  });

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
    // Schedule the setState-bearing fetch as a microtask so we don't
    // call it synchronously inside the effect body (which the React
    // 19 hooks linter flags as a cascading-render risk).
    void Promise.resolve().then(refreshSessions);
  }, [refreshSessions]);

  useEffect(() => {
    if (!visible) return;
    // Fire immediately on tab-becomes-visible so returning users see
    // fresh data instead of waiting up to a poll interval.
    void Promise.resolve().then(refreshSessions);
    const h = setInterval(refreshSessions, 5_000);
    return () => clearInterval(h);
  }, [visible, refreshSessions]);


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
      // Mobile: jump to the chat tab so the user sees their selection
      // immediately. Desktop keeps both panes visible so no-op there.
      setMobileTab("chat");
    },
    [repos, router, setActiveRun],
  );

  const handleBulkDelete = useCallback(async (list: SessionSummary[]) => {
    if (list.length === 0) return;
    const linkedCount = list.filter((s) => s.link).length;
    const linkedNote = linkedCount > 0
      ? `${linkedCount} of these are linked to tasks — links will be removed.\n\n`
      : "";
    const ok = await confirm({
      title: `Delete ${list.length} session${list.length > 1 ? "s" : ""}?`,
      description: `${linkedNote}The .jsonl files are removed from ~/.claude/projects/. Bridge task entries stay.`,
      confirmLabel: `Delete ${list.length}`,
      destructive: true,
    });
    if (!ok) return;
    // Run deletes in parallel — each hits a different .jsonl on disk so
    // there's no contention. allSettled so a single failure doesn't
    // strand the rest of the batch.
    const results = await Promise.allSettled(
      list.map((s) => api.deleteSession(s.sessionId, s.repo)),
    );
    const failed = results.filter((r) => r.status === "rejected").length;
    const succeeded = results.length - failed;
    if (failed === 0) {
      toast("info", `Deleted ${succeeded} session${succeeded > 1 ? "s" : ""}`);
    } else if (succeeded === 0) {
      toast("error", `Failed to delete ${failed} session${failed > 1 ? "s" : ""}`);
    } else {
      toast("error", `Deleted ${succeeded}, ${failed} failed`);
    }
    if (activeRun && list.some((s) => s.sessionId === activeRun.sessionId)) {
      setActiveRun(null);
    }
    await refreshSessions();
  }, [activeRun, refreshSessions, toast, confirm, setActiveRun]);

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
    setMobileTab("chat");
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
      />

      {/* Mobile-only tab bar — same UX as /tasks/[id]: pick which pane
          fills the viewport. On md+ both panes render side-by-side and
          this bar is hidden. */}
      <div className="md:hidden shrink-0 flex border-b border-border bg-card">
        <button
          type="button"
          onClick={() => setMobileTab("browser")}
          aria-pressed={mobileTab === "browser"}
          className={`flex-1 py-1.5 text-[11.5px] font-medium border-b-2 transition-colors ${
            mobileTab === "browser"
              ? "border-primary text-foreground"
              : "border-transparent text-muted-foreground hover:text-foreground"
          }`}
        >
          Sessions{orphanCount > 0 ? ` · ${orphanCount}` : ""}
        </button>
        <button
          type="button"
          onClick={() => setMobileTab("chat")}
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
        {/* Both panes stay mounted (display:none vs flex) so search
            input, scroll position, and SessionLog state survive a tab
            switch. */}
        <div
          className={`flex-1 min-h-0 md:flex-none md:flex ${
            mobileTab === "browser" ? "flex" : "hidden md:flex"
          }`}
        >
          <SessionsBrowser
            sessions={sessions}
            query={query}
            activeSessionId={activeRun?.sessionId ?? null}
            onQueryChange={setQuery}
            onSelect={handleSelectSession}
            onDelete={handleDelete}
            onBulkDelete={handleBulkDelete}
            repos={repos}
            defaultRepo={repos.find((r) => r.isBridge)?.name ?? repos[0]?.name}
            onCreateSession={handleCreate}
            newSessionRef={newSessionRef}
          />
        </div>
        <div
          className={`flex-1 min-w-0 min-h-0 md:flex ${
            mobileTab === "chat" ? "flex" : "hidden md:flex"
          }`}
        >
          <SessionLog run={activeRun} repos={repos} />
        </div>
      </main>
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
