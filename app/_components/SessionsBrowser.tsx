"use client";

import { useState } from "react";
import type { Repo, SessionSummary } from "@/lib/client/types";
import {
  ChevronDown, ChevronRight, FolderClosed, FolderOpen, GitBranch,
  Link as LinkIcon, Link2Off, Search, X, Trash2, Terminal,
} from "lucide-react";
import { relativeTime } from "@/lib/client/time";
import { EmptyState } from "./ui/empty-state";
import { NewSessionDialog } from "./NewSessionDialog";

/**
 * Render an absolute path the way VS Code does in its sessions panel:
 * forward slashes, lower-case drive letter, no trailing slash. We don't
 * try to abbreviate — the user wants to see exactly which folder owns
 * the session.
 */
function displayPath(p: string): string {
  return p.replace(/\\/g, "/").replace(/\/+$/, "");
}

export function SessionsBrowser({
  sessions,
  query,
  activeSessionId,
  onQueryChange,
  onSelect,
  onLink,
  onDelete,
  repos,
  defaultRepo,
  onCreateSession,
  newSessionRef,
}: {
  sessions: SessionSummary[];
  query: string;
  activeSessionId: string | null;
  onQueryChange: (q: string) => void;
  onSelect: (s: SessionSummary) => void;
  onLink: (s: SessionSummary) => void;
  onDelete?: (s: SessionSummary) => void;
  repos: Repo[];
  defaultRepo?: string;
  onCreateSession: (args: { repo: string }) => void;
  newSessionRef?: React.MutableRefObject<(() => void) | null>;
}) {
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

  const q = query.trim().toLowerCase();
  const filtered = q
    ? sessions.filter(
        (s) =>
          s.sessionId.toLowerCase().includes(q) ||
          s.preview.toLowerCase().includes(q) ||
          s.repo.toLowerCase().includes(q) ||
          s.repoPath.toLowerCase().includes(q) ||
          (s.link?.taskId.toLowerCase().includes(q) ?? false),
      )
    : sessions;

  // Group by absolute folder path so the panel mirrors VS Code's
  // CLAUDE SESSIONS view (one row per project dir on disk, full path
  // as the header). Sessions for a folder not in BRIDGE.md still get
  // their own group thanks to /api/sessions/all's discovery.
  const byPath = new Map<string, SessionSummary[]>();
  for (const s of filtered) {
    const key = s.repoPath || s.repo;
    if (!byPath.has(key)) byPath.set(key, []);
    byPath.get(key)!.push(s);
  }
  const groups = [...byPath.entries()].sort(([a], [b]) => a.localeCompare(b));

  const toggleGroup = (path: string) =>
    setCollapsed((prev) => ({ ...prev, [path]: !prev[path] }));

  return (
    <aside className="w-80 shrink-0 border-r border-border bg-card overflow-y-auto flex flex-col">
      <div className="p-2 border-b border-border sticky top-0 bg-card z-10 space-y-2">
        <NewSessionDialog
          repos={repos}
          defaultRepo={defaultRepo}
          onCreate={onCreateSession}
          openRef={newSessionRef}
        />
        <div className="relative">
          <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-fg-dim" />
          <input
            value={query}
            onChange={(e) => onQueryChange(e.target.value)}
            placeholder="Search sessions…"
            className="w-full bg-background border border-border rounded-md pl-8 pr-7 py-1.5 text-xs focus:outline-none focus:border-primary"
          />
          {query && (
            <button
              onClick={() => onQueryChange("")}
              className="absolute right-1.5 top-1/2 -translate-y-1/2 text-fg-dim hover:text-foreground p-0.5"
              aria-label="Clear"
            >
              <X size={12} />
            </button>
          )}
        </div>
      </div>

      <div className="p-2 flex-1">
        {filtered.length === 0 ? (
          <EmptyState
            icon={Terminal}
            title={q ? "No matches" : "No sessions yet"}
            hint={q ? "Try a different search term." : "Click New session to start a Claude chat in any registered repo."}
            className="mt-4"
          />
        ) : (
          groups.map(([path, list]) => {
            const isCollapsed = !!collapsed[path];
            const Folder = isCollapsed ? FolderClosed : FolderOpen;
            const Chevron = isCollapsed ? ChevronRight : ChevronDown;
            const branch = list[0]?.branch ?? null;
            return (
            <div key={path} className="mb-2">
              <button
                type="button"
                onClick={() => toggleGroup(path)}
                className="w-full flex items-center gap-1.5 px-1.5 py-1 rounded hover:bg-accent text-left"
                title={branch ? `${path}\n\non branch ${branch}` : path}
              >
                <Chevron size={11} className="text-fg-dim shrink-0" />
                <Folder size={11} className="text-primary shrink-0" />
                <span className="flex-1 min-w-0 font-mono text-[10.5px] text-muted-foreground truncate">
                  {displayPath(path)}
                </span>
                {branch && (
                  <span
                    className="inline-flex items-center gap-0.5 text-[9.5px] text-info font-mono shrink-0 max-w-[80px] truncate"
                    title={`branch: ${branch}`}
                  >
                    <GitBranch size={9} />
                    {branch}
                  </span>
                )}
                <span className="text-[10px] text-fg-dim tabular-nums shrink-0">
                  {list.length}
                </span>
              </button>
              {!isCollapsed && (
              <ul className="pl-3 mt-0.5">
                {list.map((s) => (
                  <li key={s.sessionId}>
                    <div
                      className={`group rounded transition-colors flex items-center gap-1 ${
                        activeSessionId === s.sessionId
                          ? "bg-primary/10 border border-primary/30"
                          : "border border-transparent hover:bg-accent"
                      }`}
                    >
                      <button
                        onClick={() => onSelect(s)}
                        className="flex-1 text-left px-2 py-1 min-w-0"
                      >
                        <div className="text-xs text-foreground line-clamp-1">
                          {s.preview || (
                            <span className="font-mono text-muted-foreground">
                              {s.sessionId.slice(0, 8)}…
                            </span>
                          )}
                        </div>
                        <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground leading-tight">
                          {s.link ? (
                            <span className="font-mono font-semibold px-1 py-px rounded bg-success/15 text-success">
                              {s.link.role}
                            </span>
                          ) : (
                            <span className="font-mono px-1 py-px rounded bg-warning/10 text-warning">
                              orphan
                            </span>
                          )}
                          {s.link && (
                            <code className="font-mono truncate">{s.link.taskId}</code>
                          )}
                          <span className="ml-auto tabular-nums">
                            {relativeTime(new Date(s.mtime).toISOString())}
                          </span>
                        </div>
                      </button>
                      <div className="flex items-center gap-0.5 pr-1 shrink-0">
                        <button
                          onClick={(e) => { e.stopPropagation(); onLink(s); }}
                          className="p-1 rounded text-fg-dim hover:text-primary hover:bg-primary/10"
                          title={s.link ? "Re-link" : "Link to task"}
                          aria-label={s.link ? "Re-link session" : "Link session to task"}
                        >
                          {s.link ? <Link2Off size={11} /> : <LinkIcon size={11} />}
                        </button>
                        {onDelete && (
                          <button
                            onClick={(e) => { e.stopPropagation(); onDelete(s); }}
                            className="p-1 rounded text-fg-dim hover:text-destructive hover:bg-destructive/10"
                            title="Delete session file"
                            aria-label="Delete session"
                          >
                            <Trash2 size={11} />
                          </button>
                        )}
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
              )}
            </div>
            );
          })
        )}
      </div>
    </aside>
  );
}
