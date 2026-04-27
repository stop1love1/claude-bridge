"use client";

import { useState } from "react";
import type { Repo, SessionSummary } from "@/lib/client/types";
import {
  ChevronDown, ChevronRight, FolderClosed, FolderOpen, GitBranch,
  Search, X, Trash2, Terminal, CheckSquare,
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
  onDelete,
  onBulkDelete,
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
  onDelete?: (s: SessionSummary) => void;
  onBulkDelete?: (sessions: SessionSummary[]) => void;
  repos: Repo[];
  defaultRepo?: string;
  onCreateSession: (args: { repo: string }) => void;
  newSessionRef?: React.MutableRefObject<(() => void) | null>;
}) {
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [selected, setSelected] = useState<Set<string>>(new Set());
  // Bulk-delete mode is opt-in: the operator clicks the toolbar toggle
  // to reveal checkboxes + the action bar. Default view stays clean
  // with per-row delete buttons only.
  const [deleteMode, setDeleteMode] = useState(false);

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

  const toggleOne = (sessionId: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(sessionId)) next.delete(sessionId);
      else next.add(sessionId);
      return next;
    });

  const setGroupSelected = (groupSessions: SessionSummary[], on: boolean) =>
    setSelected((prev) => {
      const next = new Set(prev);
      for (const s of groupSessions) {
        if (on) next.add(s.sessionId);
        else next.delete(s.sessionId);
      }
      return next;
    });

  const exitDeleteMode = () => {
    setDeleteMode(false);
    setSelected(new Set());
  };

  const selectedSessions = sessions.filter((s) => selected.has(s.sessionId));

  return (
    <aside className="w-80 shrink-0 border-r border-border bg-card overflow-y-auto flex flex-col">
      <div className="p-2 border-b border-border sticky top-0 bg-card z-10 space-y-2">
        <NewSessionDialog
          repos={repos}
          defaultRepo={defaultRepo}
          onCreate={onCreateSession}
          openRef={newSessionRef}
        />
        <div className="flex items-center gap-1.5">
          <div className="relative flex-1 min-w-0">
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
          {onBulkDelete && (
            <button
              type="button"
              onClick={() => deleteMode ? exitDeleteMode() : setDeleteMode(true)}
              className={`shrink-0 inline-flex items-center justify-center h-[30px] w-[30px] rounded-md border text-xs ${
                deleteMode
                  ? "border-destructive/50 bg-destructive/10 text-destructive"
                  : "border-border text-muted-foreground hover:text-foreground hover:bg-accent"
              }`}
              title={deleteMode ? "Exit bulk-delete mode" : "Bulk delete"}
              aria-label={deleteMode ? "Exit bulk-delete mode" : "Enter bulk-delete mode"}
              aria-pressed={deleteMode}
            >
              <CheckSquare size={13} />
            </button>
          )}
        </div>
      </div>

      {deleteMode && onBulkDelete && (
        <div className="px-2 py-1.5 border-b border-border bg-destructive/5 flex items-center gap-2 text-xs sticky top-[88px] z-10">
          <CheckSquare size={12} className="text-destructive shrink-0" />
          <span className="text-foreground tabular-nums">
            {selected.size} selected
          </span>
          <button
            type="button"
            onClick={() => onBulkDelete(selectedSessions)}
            disabled={selected.size === 0}
            className="ml-auto inline-flex items-center gap-1 px-2 py-0.5 rounded border border-destructive/40 text-destructive hover:bg-destructive/10 disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent"
            title="Delete selected sessions"
          >
            <Trash2 size={11} /> Delete
          </button>
          <button
            type="button"
            onClick={exitDeleteMode}
            className="px-2 py-0.5 rounded border border-border text-muted-foreground hover:bg-accent"
          >
            Cancel
          </button>
        </div>
      )}

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
            const groupSelectedCount = list.reduce(
              (n, s) => n + (selected.has(s.sessionId) ? 1 : 0),
              0,
            );
            const allSelected = groupSelectedCount === list.length;
            const someSelected = groupSelectedCount > 0 && !allSelected;
            return (
            <div key={path} className="mb-2">
              <div
                className="group/header w-full flex items-center gap-1.5 px-1.5 py-1 rounded hover:bg-accent"
                title={branch ? `${path}\n\non branch ${branch}` : path}
              >
                {deleteMode && onBulkDelete && (
                  <input
                    type="checkbox"
                    aria-label={allSelected ? "Deselect all in group" : "Select all in group"}
                    checked={allSelected}
                    ref={(el) => { if (el) el.indeterminate = someSelected; }}
                    onClick={(e) => e.stopPropagation()}
                    onChange={(e) => setGroupSelected(list, e.target.checked)}
                    className="h-3 w-3 accent-destructive cursor-pointer shrink-0"
                  />
                )}
                <button
                  type="button"
                  onClick={() => toggleGroup(path)}
                  className="flex-1 min-w-0 flex items-center gap-1.5 text-left"
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
              </div>
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
                      {deleteMode && onBulkDelete && (
                        <input
                          type="checkbox"
                          aria-label="Select session"
                          checked={selected.has(s.sessionId)}
                          onChange={() => toggleOne(s.sessionId)}
                          onClick={(e) => e.stopPropagation()}
                          className="h-3 w-3 accent-destructive cursor-pointer shrink-0 ml-1.5"
                        />
                      )}
                      <button
                        onClick={() => deleteMode ? toggleOne(s.sessionId) : onSelect(s)}
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
                      {!deleteMode && onDelete && (
                        <div className="flex items-center gap-0.5 pr-1 shrink-0">
                          <button
                            onClick={(e) => { e.stopPropagation(); onDelete(s); }}
                            className="p-1 rounded text-fg-dim hover:text-destructive hover:bg-destructive/10"
                            title="Delete session file"
                            aria-label="Delete session"
                          >
                            <Trash2 size={11} />
                          </button>
                        </div>
                      )}
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
