// /sessions page — global session browser.
//
// Desktop: two-pane layout — SessionsBrowser on the left, SessionLog
// on the right.
// Mobile: tabbed; only one pane visible at a time. Both panes stay
// mounted (display:none vs flex) so search input / scroll position
// survives a tab swap.
//
// URL state: `?sid=<id>&repo=<name>` — matches main and the rest of
// the SPA (TaskDetail uses `?sid=` too). When the selected session is
// linked to a tracked task we deep-link straight to the task view at
// `/tasks/<taskId>?sid=<sid>` so the operator lands in the same UI
// they would have opened from the kanban.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import SessionsBrowser from "@/components/SessionsBrowser";
import { SessionLog } from "@/components/SessionLog";
import { useToast } from "@/components/Toasts";
import { useConfirm } from "@/components/ConfirmProvider";
import {
  qk,
  useKillSession,
  useRepos,
  useSessions,
} from "@/api/queries";
import type { SessionSummary } from "@/api/types";

const POLL_MS = 5_000;

export default function Sessions() {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const killSession = useKillSession();

  // Pause polling when the tab is hidden. Saves CPU + bandwidth on
  // long-lived background tabs and avoids piling up requests that
  // will all fire at once when the user comes back. Mirrors main's
  // visibility-aware refresh loop.
  const [visible, setVisible] = useState(
    typeof document !== "undefined"
      ? document.visibilityState === "visible"
      : true,
  );
  useEffect(() => {
    const onVis = () => setVisible(document.visibilityState === "visible");
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, []);

  const { data, isLoading, error } = useSessions();
  // Re-export the underlying query options through the existing hook
  // by overriding refetch behavior at the page level. The hook
  // doesn't currently take options, but we can rely on react-query's
  // default focus refetch + an explicit setInterval driven by the
  // `visible` state. Cheap and matches main exactly.
  const { data: reposData } = useRepos();
  const repos = useMemo(() => reposData?.repos ?? [], [reposData]);

  const sessions = useMemo<SessionSummary[]>(() => data ?? [], [data]);

  const sid = params.get("sid");
  const repo = params.get("repo");

  // Mobile pane toggle: default to chat if a session is in the URL
  // (deep-link case), else show the browser first.
  const [mobileTab, setMobileTab] = useState<"browser" | "chat">(() =>
    sid ? "chat" : "browser",
  );
  useEffect(() => {
    if (sid) setMobileTab("chat");
  }, [sid]);

  const activeSession = useMemo(() => {
    if (!sid) return null;
    return sessions.find((s) => s.sessionId === sid) ?? null;
  }, [sessions, sid]);

  // The dialog inside SessionsBrowser exposes a programmatic open
  // handle — hand it a slot here in case a future keyboard shortcut
  // wants to call it. Unused today but matches main's contract.
  const newSessionRef = useRef<(() => void) | null>(null);

  // ---- Visibility-paused 5 s polling ----------------------------------
  // useSessions doesn't take a refetchInterval prop today (keeps the
  // queries.ts surface clean), so we drive polling here by calling
  // invalidateQueries on the sessions key whenever the tab is
  // visible. When the tab is hidden we skip — saves CPU + bandwidth
  // on long-lived background tabs and avoids piling up requests
  // that all fire at once when the user comes back.
  useEffect(() => {
    if (!visible) return;
    void queryClient.invalidateQueries({ queryKey: qk.sessions });
    const id = setInterval(() => {
      void queryClient.invalidateQueries({ queryKey: qk.sessions });
    }, POLL_MS);
    return () => clearInterval(id);
  }, [visible, queryClient]);

  // ---- Selection -----------------------------------------------------
  // If the session is linked to a tracked task, jump to the task view
  // (preserves the deep-link behavior main had: same UI as opening
  // the run from the kanban). Otherwise stay on /sessions and select.
  const onSelect = useCallback(
    (s: SessionSummary) => {
      if (s.link) {
        navigate(`/tasks/${s.link.taskId}?sid=${s.sessionId}`);
        return;
      }
      const next = new URLSearchParams(params);
      next.set("sid", s.sessionId);
      next.set("repo", s.repo);
      // Drop the legacy `?session=` key if it was carried over from
      // an old bookmark — the SPA only reads `?sid=` now.
      next.delete("session");
      setParams(next, { replace: true });
      setMobileTab("chat");
    },
    [navigate, params, setParams],
  );

  // ---- Bulk-kill -----------------------------------------------------
  // Backend gap: there is no `delete-session` endpoint today (the Go
  // bridge only offers POST /api/sessions/{sid}/kill, which terminates
  // an active spawn but leaves the .jsonl on disk). The bulk action
  // is therefore labelled "Kill" in the UI to match the wire reality.
  const handleBulkKill = useCallback(
    async (list: SessionSummary[]) => {
      if (list.length === 0) return;
      const linkedCount = list.filter((s) => s.link).length;
      const linkedNote =
        linkedCount > 0
          ? `${linkedCount} of these are linked to tasks. Killing the spawn does not unlink the run.\n\n`
          : "";
      const ok = await confirm({
        title: `Kill ${list.length} session${list.length > 1 ? "s" : ""}?`,
        description: `${linkedNote}This signals the running claude process for each session. Idle sessions are a no-op.`,
        confirmLabel: `Kill ${list.length}`,
        variant: "destructive",
      });
      if (!ok) return;
      const results = await Promise.allSettled(
        list.map((s) => killSession.mutateAsync(s.sessionId)),
      );
      const failed = results.filter((r) => r.status === "rejected").length;
      const succeeded = results.length - failed;
      if (failed === 0) {
        toast.success(
          `Killed ${succeeded} session${succeeded > 1 ? "s" : ""}`,
        );
      } else if (succeeded === 0) {
        toast.error(
          `Failed to kill ${failed} session${failed > 1 ? "s" : ""}`,
        );
      } else {
        toast.warning(`Killed ${succeeded}, ${failed} failed`);
      }
      // If the active session was in the kill set, clear the URL so
      // the chat pane stops trying to tail a dead spawn.
      if (sid && list.some((s) => s.sessionId === sid)) {
        const next = new URLSearchParams(params);
        next.delete("sid");
        next.delete("repo");
        setParams(next, { replace: true });
      }
    },
    [confirm, killSession, params, setParams, sid, toast],
  );

  // ---- Create new session -------------------------------------------
  // Generate the UUID client-side and jump straight into an empty
  // SessionLog. The actual `claude` spawn is deferred until the user
  // types their first message — the /api/sessions/<id>/message route
  // detects the missing .jsonl and starts a fresh session at that
  // UUID instead of resuming. No server round-trip needed here.
  const handleCreate = useCallback(
    ({ repo: repoName }: { repo: string }) => {
      const repoEntry = repos.find((r) => r.name === repoName);
      if (!repoEntry) {
        toast.error(`unknown repo: ${repoName}`);
        return;
      }
      const sessionId =
        typeof crypto !== "undefined" && "randomUUID" in crypto
          ? crypto.randomUUID()
          : `${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}`;
      const next = new URLSearchParams(params);
      next.set("sid", sessionId);
      next.set("repo", repoName);
      next.delete("session");
      setParams(next, { replace: true });
      setMobileTab("chat");
    },
    [params, repos, setParams, toast],
  );

  // ---- Default repo for the New session dropdown --------------------
  // Bridge entry first (operator's home base); fall back to the first
  // existing app, then any repo, then "" empty.
  const defaultRepo = useMemo(() => {
    return (
      repos.find((r) => r.isBridge && r.exists)?.name ??
      repos.find((r) => r.exists)?.name ??
      repos[0]?.name ??
      ""
    );
  }, [repos]);

  // ---- Orphan-count badge -------------------------------------------
  // Surface the number of sessions not linked to any task (these are
  // "drive-by" claude spawns the operator started directly). Mirrors
  // main's MainNav badge.
  const orphanCount = useMemo(
    () => sessions.filter((s) => !s.link).length,
    [sessions],
  );

  if (error) {
    return (
      <div className="mx-auto max-w-3xl px-6 py-10 text-sm text-destructive">
        {(error as Error).message}
      </div>
    );
  }

  return (
    <div className="flex h-[calc(100vh-2.75rem)] flex-col">
      {/* Mobile tab bar */}
      <div className="flex shrink-0 border-b border-border bg-card md:hidden">
        <Tabs
          value={mobileTab}
          onValueChange={(v) => setMobileTab(v as "browser" | "chat")}
          className="w-full"
        >
          <TabsList className="m-2 w-[calc(100%-1rem)]">
            <TabsTrigger value="browser" className="flex-1">
              Sessions ({sessions.length})
              {orphanCount > 0 ? ` · ${orphanCount}` : ""}
            </TabsTrigger>
            <TabsTrigger value="chat" className="flex-1">
              {activeSession ? activeSession.sessionId.slice(0, 8) : "Chat"}
            </TabsTrigger>
          </TabsList>
        </Tabs>
      </div>

      <main className="flex min-h-0 flex-1 flex-col overflow-hidden md:flex-row">
        <div
          className={
            mobileTab === "browser"
              ? "flex min-h-0 flex-1 md:flex-none"
              : "hidden min-h-0 md:flex md:flex-none"
          }
        >
          <SessionsBrowser
            sessions={sessions}
            activeSessionId={sid}
            onSelect={onSelect}
            repos={repos}
            defaultRepo={defaultRepo}
            onCreateSession={handleCreate}
            onBulkKill={handleBulkKill}
            newSessionRef={newSessionRef}
          />
        </div>
        <div
          className={
            mobileTab === "chat"
              ? "flex min-h-0 flex-1 md:flex"
              : "hidden min-h-0 md:flex md:flex-1"
          }
        >
          {isLoading && sessions.length === 0 ? (
            <div className="flex h-full w-full items-center justify-center text-xs text-fg-dim">
              Loading sessions…
            </div>
          ) : (
            <div className="flex w-full flex-col">
              <SessionLog
                sessionId={sid ?? undefined}
                repo={repo ?? undefined}
                role={activeSession?.link?.role}
              />
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
