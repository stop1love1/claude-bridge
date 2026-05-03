// SessionsBrowser — left pane for the /sessions page. Lists every
// session row returned by /api/sessions/all, grouped by absolute
// project path so the layout mirrors VS Code's CLAUDE SESSIONS panel.
//
// Filters: free-text search (matches id, preview, repo, repo path,
// linked taskId), repo dropdown.
//
// Selection drives the parent's URL state (`?session=&repo=`).

import { useMemo, useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  GitBranch,
  Search,
  Terminal,
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
import { relTime } from "@/lib/time";
import { cn } from "@/lib/cn";
import type { SessionSummary } from "@/api/types";

const REPO_ALL = "__all__";

interface Props {
  sessions: SessionSummary[];
  activeSessionId: string | null;
  onSelect: (s: SessionSummary) => void;
}

function displayPath(p: string): string {
  return p.replace(/\\/g, "/").replace(/\/+$/, "");
}

export default function SessionsBrowser({
  sessions,
  activeSessionId,
  onSelect,
}: Props) {
  const [query, setQuery] = useState("");
  const [repoFilter, setRepoFilter] = useState<string>(REPO_ALL);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

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

  return (
    <aside className="flex h-full w-full flex-col overflow-hidden border-border md:w-80 md:shrink-0 md:border-r">
      <div className="sticky top-0 z-10 shrink-0 space-y-2 border-b border-border bg-surface p-2">
        <div className="relative">
          <Search
            size={12}
            className="absolute left-2 top-1/2 -translate-y-1/2 text-muted-2"
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
              className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-2 hover:text-fg"
              aria-label="clear search"
            >
              <X size={11} />
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
            return (
              <div key={path} className="mb-2">
                <button
                  type="button"
                  onClick={() => toggleGroup(path)}
                  className="flex w-full items-center gap-1.5 rounded-sm px-1.5 py-1 text-left hover:bg-surface-2"
                  title={branch ? `${path}\n\non branch ${branch}` : path}
                >
                  <Chevron size={11} className="shrink-0 text-muted-2" />
                  <span className="min-w-0 flex-1 truncate font-mono text-[10.5px] text-muted">
                    {displayPath(path)}
                  </span>
                  {branch && (
                    <span
                      className="inline-flex shrink-0 items-center gap-0.5 truncate font-mono text-[9.5px] text-accent"
                      title={`branch: ${branch}`}
                    >
                      <GitBranch size={9} />
                      {branch}
                    </span>
                  )}
                  <span className="shrink-0 font-mono text-[10px] tabular-nums text-muted-2">
                    {list.length}
                  </span>
                </button>
                {!isCollapsed && (
                  <ul className="mt-0.5 pl-3">
                    {list.map((s) => (
                      <li key={s.sessionId}>
                        <button
                          type="button"
                          onClick={() => onSelect(s)}
                          className={cn(
                            "group flex w-full items-center gap-1.5 rounded-sm border px-2 py-1 text-left transition-colors",
                            activeSessionId === s.sessionId
                              ? "border-accent/40 bg-accent/10"
                              : "border-transparent hover:bg-surface-2",
                          )}
                        >
                          <span className="min-w-0 flex-1 truncate text-xs text-fg">
                            {s.preview || (
                              <span className="font-mono text-muted">
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
                            <code className="max-w-[110px] shrink-0 truncate font-mono text-[10px] text-muted-2">
                              {s.link.taskId}
                            </code>
                          )}
                          <span className="shrink-0 font-mono text-[10px] tabular-nums text-muted-2">
                            {relTime(new Date(s.mtime).toISOString())}
                          </span>
                        </button>
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
