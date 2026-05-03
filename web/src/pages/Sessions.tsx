// /sessions page — global session browser.
//
// Desktop: two-pane layout — SessionsBrowser on the left, SessionLog
// on the right.
// Mobile: tabbed; only one pane visible at a time. Both panes stay
// mounted (display:none vs flex) so search input / scroll position
// survives a tab swap.
//
// URL state: `?session=<id>&repo=<name>` — deep-linking from a chat
// log preserves which session the user was reading.

import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useSessions } from "@/api/queries";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import SessionsBrowser from "@/components/SessionsBrowser";
import { SessionLog } from "@/components/SessionLog";
import type { SessionSummary } from "@/api/types";

export default function Sessions() {
  const [params, setParams] = useSearchParams();
  const { data, isLoading, error } = useSessions();

  const sessionId = params.get("session");
  const repo = params.get("repo");

  // Mobile pane toggle: default to chat if a session is in the URL
  // (deep-link case), else show the browser first.
  const [mobileTab, setMobileTab] = useState<"browser" | "chat">(() =>
    sessionId ? "chat" : "browser",
  );

  useEffect(() => {
    if (sessionId) setMobileTab("chat");
  }, [sessionId]);

  const sessions = useMemo<SessionSummary[]>(() => data ?? [], [data]);

  const activeSession = useMemo(() => {
    if (!sessionId) return null;
    return sessions.find((s) => s.sessionId === sessionId) ?? null;
  }, [sessions, sessionId]);

  const onSelect = (s: SessionSummary) => {
    const next = new URLSearchParams(params);
    next.set("session", s.sessionId);
    next.set("repo", s.repo);
    setParams(next, { replace: true });
    setMobileTab("chat");
  };

  if (error) {
    return (
      <div className="mx-auto max-w-3xl px-6 py-10 font-mono text-small text-status-blocked">
        {(error as Error).message}
      </div>
    );
  }

  return (
    <div className="flex h-[calc(100vh-3.5rem)] flex-col">
      {/* Mobile tab bar */}
      <div className="flex shrink-0 border-b border-border bg-card md:hidden">
        <Tabs
          value={mobileTab}
          onValueChange={(v) => setMobileTab(v as "browser" | "chat")}
          className="w-full"
        >
          <TabsList className="m-2 w-[calc(100%-1rem)]">
            <TabsTrigger value="browser" className="flex-1">
              sessions ({sessions.length})
            </TabsTrigger>
            <TabsTrigger value="chat" className="flex-1">
              {activeSession ? activeSession.sessionId.slice(0, 8) : "chat"}
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
            activeSessionId={sessionId}
            onSelect={onSelect}
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
            <div className="flex h-full w-full items-center justify-center font-mono text-micro tracking-wideish text-fg-dim">
              loading sessions…
            </div>
          ) : (
            <div className="flex w-full flex-col">
              <SessionLog
                sessionId={sessionId ?? undefined}
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
