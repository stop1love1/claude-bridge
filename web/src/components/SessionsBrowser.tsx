// SessionsBrowser — left pane for the /sessions page. Lists every
// session row returned by /api/sessions/all, grouped by absolute
// project path so the layout mirrors VS Code's CLAUDE SESSIONS panel.
//
// Filters: free-text search (matches id, preview, repo, repo path,
// linked taskId), repo dropdown.
//
// Header surfaces a + New session button (NewSessionDialog) and a
// bulk-select toggle. In bulk mode each row gets a checkbox plus a
// group-level select-all with indeterminate state, and a sticky
// action bar at the top of the list shows "N selected · Kill".
//
// Selection drives the parent's URL state (`?sid=&repo=`).

import { useMemo, useState } from "react";
import {
  CheckSquare,
  ChevronDown,
  ChevronRight,
  GitBranch,
  Search,
  Terminal,
  Trash2,
  X,
} from "lucide-react";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { EmptyState } from "@/components/ui/empty-state";
import { NewSessionDialog } from "@/components/NewSessionDialog";
import { relTime } from "@/lib/time";
import { cn } from "@/lib/cn";
import type { Repo, SessionSummary } from "@/api/types";

const REPO_ALL = "__all__";

interface Props {
  sessions: SessionSummary[];
  activeSessionId: string | null;
  onSelect: (s: SessionSummary) => void;
  /**
   * Repos for the New session dropdown. Optional — when omitted the
   * "+ New session" header is hidden (used in narrower embeddings).
   */
  repos?: Repo[];
  defaultRepo?: string;
  onCreateSession?: (args: { repo: string }) => void;
  /**
   * Bulk-kill / delete handler. The browser surfaces the toggle and
   * collects the selection; the page decides what "kill" means
   * (today: POST /api/sessions/{sid}/kill via useKillSession).
   */
  onBulkKill?: (selected: SessionSummary[]) => void | Promise<void>;
  /**
   * Programmatic open handle for the New session control. Wired by
   * the page so a keyboard shortcut can fire creation.
   */
  newSessionRef?: React.MutableRefObject<(() => void) | null>;
}

function displayPath(p: string): string {
  return p.replace(/\\/g, "/").replace(/\/+$/, "");
}

export default function SessionsBrowser({
  sessions,
  activeSessionId,
  onSelect,
  repos,
  defaultRepo,
  onCreateSession,
  onBulkKill,
  newSessionRef,
}: Props) {
  const [query, setQuery] = useState("");
  const [repoFilter, setRepoFilter] = useState<string>(REPO_ALL);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  // Bulk-kill mode is opt-in: the operator clicks the toolbar toggle
  // to reveal checkboxes + the action bar. Default view stays clean.
  const [killMode, setKillMode] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const repoOptions = useMemo(() => {
    const seen = new Set<string>();
    for (const s of sessions) seen.add(s.repo);
    return [...seen].sort();
  }, [sessions]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return sessions.filter((s) => {
      if (repoFilter !== REPO_ALL && s.repo !== repoFilter) return false;
      if (!q) return true;
      return (
        s.sessionId.toLowerCase().includes(q) ||
        (s.preview ?? "").toLowerCase().includes(q) ||
        s.repo.toLowerCase().includes(q) ||
        (s.repoPath ?? "").toLowerCase().includes(q) ||
        (s.link?.taskId.toLowerCase().includes(q) ?? false)
      );
    });
  }, [sessions, query, repoFilter]);

  const groups = useMemo(() => {
    const m = new Map<string, SessionSummary[]>();
    for (const s of filtered) {
      const key = s.repoPath || s.repo;
      if (!m.has(key)) m.set(key, []);
      m.get(key)!.push(s);
    }
    return [...m.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [filtered]);

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

  const exitKillMode = () => {
    setKillMode(false);
    setSelected(new Set());
  };

  const selectedSessions = useMemo(
    () => sessions.filter((s) => selected.has(s.sessionId)),
    [sessions, selected],
  );

  const handleBulkKill = async () => {
    if (!onBulkKill || selectedSessions.length === 0) return;
    await onBulkKill(selectedSessions);
    exitKillMode();
  };

  const showNewSessionRow =
    !!onCreateSession && !!repos && repos.length > 0;

  return (
    <aside className="flex h-full w-full flex-col overflow-hidden border-border md:w-80 md:shrink-0 md:border-r">
      <div className="sticky top-0 z-10 shrink-0 space-y-2 border-b border-border bg-card p-2">
        {showNewSessionRow && (
          <NewSessionDialog
            repos={repos!}
            defaultRepo={defaultRepo}
            onCreate={onCreateSession!}
            openRef={newSessionRef}
          />
        )}
        <div className="flex items-center gap-1.5">
          <div className="relative min-w-0 flex-1">
            <Search
              size={12}
              className="absolute left-2 top-1/2 -translate-y-1/2 text-fg-dim"
            />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="search sessions…"
              className="pl-7 pr-7"
            />
            {query && (
              <button
                type="button"
                onClick={() => setQuery("")}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-fg-dim hover:text-foreground"
                aria-label="clear search"
              >
                <X size={11} />
              </button>
            )}
          </div>
          {onBulkKill && (
            <button
              type="button"
              onClick={() => (killMode ? exitKillMode() : setKillMode(true))}
              className={cn(
                "inline-flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-md border text-xs",
                killMode
                  ? "border-status-blocked/50 bg-status-blocked/10 text-status-blocked"
                  : "border-border text-muted-foreground hover:bg-secondary hover:text-foreground",
              )}
              title={killMode ? "Exit bulk-kill mode" : "Bulk kill"}
              aria-label={killMode ? "Exit bulk-kill mode" : "Enter bulk-kill mode"}
              aria-pressed={killMode}
            >
              <CheckSquare size={13} />
            </button>
          )}
        </div>
        <Select value={repoFilter} onValueChange={setRepoFilter}>
          <SelectTrigger>
            <SelectValue placeholder="repo" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={REPO_ALL}>— all repos —</SelectItem>
            {repoOptions.map((r) => (
              <SelectItem key={r} value={r}>
                {r}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {killMode && onBulkKill && (
        <div className="sticky top-0 z-10 flex shrink-0 items-center gap-2 border-b border-border bg-status-blocked/5 px-2 py-1.5 text-xs">
          <CheckSquare size={12} className="shrink-0 text-status-blocked" />
          <span className="tabular-nums text-foreground">
            {selected.size} selected
          </span>
          <button
            type="button"
            onClick={handleBulkKill}
            disabled={selected.size === 0}
            className="ml-auto inline-flex h-6 items-center gap-1 rounded border border-status-blocked/40 px-2 text-status-blocked hover:bg-status-blocked/10 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent"
            title="Kill selected sessions"
            aria-label="Kill selected sessions"
          >
            <Trash2 size={11} />
            Kill
          </button>
          <button
            type="button"
            onClick={exitKillMode}
            className="inline-flex h-6 w-6 items-center justify-center rounded border border-border text-muted-foreground hover:bg-secondary"
            title="Cancel"
            aria-label="Cancel bulk-kill"
          >
            <X size={11} />
          </button>
        </div>
      )}

      <div className="flex-1 overflow-y-auto p-2">
        {filtered.length === 0 ? (
          <EmptyState
            icon={Terminal}
            title={query ? "no matches" : "no sessions yet"}
            hint={
              query
                ? "try a different search term."
                : "child claude sessions show up here once they start."
            }
            className="mt-4"
          />
        ) : (
          groups.map(([path, list]) => {
            const isCollapsed = !!collapsed[path];
            const Chevron = isCollapsed ? ChevronRight : ChevronDown;
            const branch = list[0]?.branch ?? null;
            const groupSelectedCount = list.reduce(
              (n, s) => n + (selected.has(s.sessionId) ? 1 : 0),
              0,
            );
            const allSelected =
              groupSelectedCount === list.length && list.length > 0;
            const someSelected =
              groupSelectedCount > 0 && groupSelectedCount < list.length;
            return (
              <div key={path} className="mb-2">
                <div
                  className="group/header flex w-full items-center gap-1.5 rounded-sm px-1.5 py-1 text-left hover:bg-secondary"
                  title={branch ? `${path}\n\non branch ${branch}` : path}
                >
                  {killMode && onBulkKill && (
                    <input
                      type="checkbox"
                      aria-label={
                        allSelected
                          ? "Deselect all in group"
                          : "Select all in group"
                      }
                      checked={allSelected}
                      ref={(el) => {
                        if (el) el.indeterminate = someSelected;
                      }}
                      onClick={(e) => e.stopPropagation()}
                      onChange={(e) => setGroupSelected(list, e.target.checked)}
                      className="h-3 w-3 shrink-0 cursor-pointer accent-status-blocked"
                    />
                  )}
                  <button
                    type="button"
                    onClick={() => toggleGroup(path)}
                    className="flex min-w-0 flex-1 items-center gap-1.5"
                  >
                    <Chevron size={11} className="shrink-0 text-fg-dim" />
                    <span className="min-w-0 flex-1 truncate font-mono text-[10.5px] text-muted-foreground">
                      {displayPath(path)}
                    </span>
                    {branch && (
                      <span
                        className="inline-flex shrink-0 items-center gap-0.5 truncate font-mono text-[9.5px] text-primary"
                        title={`branch: ${branch}`}
                      >
                        <GitBranch size={9} />
                        {branch}
                      </span>
                    )}
                    <span className="shrink-0 font-mono text-[10px] tabular-nums text-fg-dim">
                      {list.length}
                    </span>
                  </button>
                </div>
                {!isCollapsed && (
                  <ul className="mt-0.5 pl-3">
                    {list.map((s) => (
                      <li key={s.sessionId}>
                        <div
                          className={cn(
                            "group flex items-center gap-1 rounded-sm border transition-colors",
                            activeSessionId === s.sessionId
                              ? "border-primary/40 bg-primary/10"
                              : "border-transparent hover:bg-secondary",
                          )}
                        >
                          {killMode && onBulkKill && (
                            <input
                              type="checkbox"
                              aria-label="Select session"
                              checked={selected.has(s.sessionId)}
                              onChange={() => toggleOne(s.sessionId)}
                              onClick={(e) => e.stopPropagation()}
                              className="ml-1.5 h-3 w-3 shrink-0 cursor-pointer accent-status-blocked"
                            />
                          )}
                          <button
                            type="button"
                            onClick={() =>
                              killMode ? toggleOne(s.sessionId) : onSelect(s)
                            }
                            className="flex min-w-0 flex-1 items-center gap-1.5 px-2 py-1 text-left"
                          >
                            <span className="min-w-0 flex-1 truncate text-xs text-foreground">
                              {s.preview || (
                                <span className="font-mono text-muted-foreground">
                                  {s.sessionId.slice(0, 8)}…
                                </span>
                              )}
                            </span>
                            {s.link && (
                              <span className="shrink-0 rounded border border-status-done/40 bg-status-done/10 px-1 py-px font-mono text-[10px] font-semibold text-status-done">
                                {s.link.role}
                              </span>
                            )}
                            {s.link && (
                              <code className="max-w-[110px] shrink-0 truncate font-mono text-[10px] text-fg-dim">
                                {s.link.taskId}
                              </code>
                            )}
                            <span className="shrink-0 font-mono text-[10px] tabular-nums text-fg-dim">
                              {relTime(new Date(s.mtime).toISOString())}
                            </span>
                          </button>
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
