"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import {
  ArrowLeft,
  ChevronDown,
  FolderTree,
  GitBranch,
  GitCommit,
  RefreshCw,
  Loader2,
  Send,
  Sparkles,
  Terminal as TerminalIcon,
  ListChecks,
} from "lucide-react";
import { api } from "@/libs/client/api";
import {
  parseUnifiedDiff,
  buildFileTree,
  squashSingleDir,
  FileTreeView,
  FileDiffPane,
  type FileDiffEntry,
} from "./DiffViewer";
import { AppSourceTreeTab } from "./AppSourceTreeTab";
import { Button } from "./ui/button";
import { HeaderShell } from "./HeaderShell";
import { useToast } from "./Toasts";
import { relativeTime } from "@/libs/client/time";
import { SECTION_BLOCKED, SECTION_DOING, SECTION_DONE, SECTION_TODO } from "@/libs/tasks";
import type { Task } from "@/libs/client/types";

interface StatusPayload {
  cwd: string;
  branch: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  head: string | null;
  counts: { modified: number; added: number; deleted: number; renamed: number; untracked: number };
  clean: boolean;
}

interface CommitEntry {
  sha: string;
  shortSha: string;
  author: string;
  email: string;
  at: number;
  subject: string;
}

type Tab = "source" | "diff" | "commits" | "tasks";

/**
 * App detail page — git management + uncommitted diff + an inline
 * terminal for one-shot shell commands.
 *
 * Layout (Linear/Notion-style clean):
 *   - Global `HeaderShell` (same as other bridge pages) stays visible
 *   - Combined app header: back to Apps, app title, refresh; second row
 *     for git branch chip, change summary, cwd path
 *   - Tab bar: Source code / Diff / Commits / Tasks
 *   - Tab content fills the remaining space
 *   - Terminal docks at the bottom: collapsed by default to a 36px bar,
 *     drag-resizable when open, click the chevron to toggle
 *
 * The previous fixed `grid-rows-[1fr_320px]` ate a third of the screen
 * for the terminal even when the operator was reading the diff. The new
 * layout reclaims that space and only spends it when the user opts in.
 */
const TERMINAL_DEFAULT_HEIGHT = 280;
const TERMINAL_MIN_HEIGHT = 160;
const TERMINAL_BAR_HEIGHT = 36;

export function AppDetail({ name }: { name: string }) {
  const [status, setStatus] = useState<StatusPayload | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("diff");
  /** Registry `name` for the header; `name` prop is often an encoded path segment. */
  const [displayTitle, setDisplayTitle] = useState(name);
  // Terminal docking state. Collapsed by default so the diff/commits
  // tab gets the full viewport on first paint.
  const [terminalOpen, setTerminalOpen] = useState(false);
  const [terminalHeight, setTerminalHeight] = useState(TERMINAL_DEFAULT_HEIGHT);

  useEffect(() => {
    let cancelled = false;
    setDisplayTitle(name);
    void api.apps().then((apps) => {
      if (cancelled) return;
      const byPath = apps.find((a) => a.path === name);
      const bySlug = apps.find((a) => a.name === name);
      const hit = byPath ?? bySlug;
      if (hit) setDisplayTitle(hit.name);
    }).catch(() => { /* keep `name` as fallback */ });
    return () => { cancelled = true; };
  }, [name]);

  useEffect(() => {
    document.title = `${displayTitle} · Apps | Claude Bridge`;
  }, [displayTitle]);

  // Initial + manual refresh for the status header.
  const reloadStatus = useCallback(() => {
    const ac = new AbortController();
    api.appStatus(name, { signal: ac.signal })
      .then((r) => { setStatus(r); setStatusError(null); })
      .catch((e) => {
        if (ac.signal.aborted) return;
        setStatusError((e as Error).message);
      });
    return () => ac.abort();
  }, [name]);
  useEffect(() => reloadStatus(), [reloadStatus]);

  return (
    <div className="flex flex-col h-dvh overflow-hidden bg-background">
      <HeaderShell active="apps" />
      <div className="flex flex-1 min-h-0 flex-col overflow-hidden">
        <AppDetailPageHeader
          title={displayTitle}
          status={status}
          error={statusError}
          onRefresh={reloadStatus}
        />
        <TabBar
          active={tab}
          onChange={setTab}
          diffCount={
            status && !status.clean
              ? status.counts.modified +
                status.counts.added +
                status.counts.deleted +
                status.counts.renamed +
                status.counts.untracked
              : 0
          }
        />

        <div className="flex flex-1 min-h-0 flex-col overflow-hidden">
          <main className="flex-1 min-h-0 overflow-hidden">
            {tab === "source" && <AppSourceTreeTab appKey={name} />}
            {tab === "diff" && (
              <DiffTab name={name} onAfterCommit={reloadStatus} />
            )}
            {tab === "commits" && <CommitsTab name={name} />}
            {tab === "tasks" && <TasksTab name={name} />}
          </main>

          {/* Terminal: collapsed bar by default; drag the top edge to
              resize when open; click the chevron to toggle. */}
          <TerminalPanel
            name={name}
            open={terminalOpen}
            height={terminalHeight}
            minHeight={TERMINAL_MIN_HEIGHT}
            barHeight={TERMINAL_BAR_HEIGHT}
            onToggle={() => setTerminalOpen((v) => !v)}
            onResize={setTerminalHeight}
            onMaybeChangedRepo={() => {
              // Most commands the operator runs (git pull, git checkout,
              // pnpm install creating a lockfile diff…) plausibly mutate
              // the working tree. Refresh the header status after every
              // command so badges stay honest.
              reloadStatus();
            }}
          />
        </div>
      </div>
    </div>
  );
}

/* ─────────────────────────── Page chrome ─────────────────────────── */

function AppDetailPageHeader({
  title,
  status,
  error,
  onRefresh,
}: {
  title: string;
  status: StatusPayload | null;
  error: string | null;
  onRefresh: () => void;
}) {
  return (
    <header className="shrink-0 border-b border-border bg-card/40">
      <div className="px-4 sm:px-6 py-3 sm:py-4">
        <div className="flex flex-col gap-3">
          <div className="flex items-center justify-between gap-3 min-w-0">
            <div className="flex items-center gap-2 sm:gap-3 min-w-0 flex-1">
              <Link
                href="/apps"
                className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-border/80 bg-background/80 px-2 py-1.5 text-[11px] sm:text-xs font-medium text-muted-foreground shadow-sm transition-colors hover:border-border hover:bg-accent hover:text-foreground"
              >
                <ArrowLeft className="size-3.5 opacity-80" aria-hidden />
                Apps
              </Link>
              <span className="hidden sm:block h-6 w-px shrink-0 bg-border" aria-hidden />
              <h1
                className="min-w-0 flex-1 truncate text-base font-semibold tracking-tight text-foreground sm:text-lg md:text-xl"
                title={title}
              >
                {title}
              </h1>
            </div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={onRefresh}
              title="Refresh git status"
              className="shrink-0 gap-1.5 h-8 sm:h-9 px-2.5 sm:px-3 text-xs font-medium shadow-sm"
            >
              <RefreshCw className="size-3.5" strokeWidth={2} />
              <span className="hidden min-[380px]:inline">Refresh</span>
            </Button>
          </div>

          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5 text-xs text-muted-foreground">
              {status?.branch && (
                <span
                  className="inline-flex items-center gap-1.5 rounded-md border border-border bg-background/60 px-2 py-0.5 font-mono text-[11px] sm:text-xs text-foreground/90"
                  title={status.upstream ?? "no upstream"}
                >
                  <GitBranch className="size-3 shrink-0 text-primary/80" aria-hidden />
                  {status.branch}
                </span>
              )}
              {status && (status.ahead > 0 || status.behind > 0) && (
                <span
                  className="inline-flex items-center gap-1.5 rounded-md border border-border/80 px-1.5 py-0.5 font-mono text-[11px]"
                  title="Ahead / behind upstream"
                >
                  {status.ahead > 0 && (
                    <span className="text-success tabular-nums">↑{status.ahead}</span>
                  )}
                  {status.ahead > 0 && status.behind > 0 && (
                    <span className="text-border">·</span>
                  )}
                  {status.behind > 0 && (
                    <span className="text-warning tabular-nums">↓{status.behind}</span>
                  )}
                </span>
              )}
              {status && !status.clean && <ChangeSummary counts={status.counts} />}
              {status && status.clean && (
                <span className="inline-flex items-center gap-1.5 rounded-full border border-success/25 bg-success/10 px-2 py-0.5 text-[11px] font-medium text-success">
                  <span className="size-1.5 rounded-full bg-success" aria-hidden />
                  clean
                </span>
              )}
            </div>
            {status?.cwd && (
              <p
                className="font-mono text-[10px] sm:text-2xs text-muted-foreground/90 truncate sm:max-w-[55%] sm:text-right leading-relaxed"
                title={status.cwd}
              >
                {status.cwd}
              </p>
            )}
          </div>

          {error && (
            <p className="rounded-md border border-destructive/30 bg-destructive/10 px-2 py-1.5 text-2xs text-destructive font-mono">
              {error}
            </p>
          )}
        </div>
      </div>
    </header>
  );
}

/**
 * Compact change-summary row. Each non-zero count gets a small dot in
 * the canonical git color (M=warning, A=success, D=destructive, R=info,
 * ?=fg-dim). Lower visual weight than the previous "M3 A1 D2" inline
 * which competed with the branch label.
 */
function ChangeSummary({ counts }: { counts: StatusPayload["counts"] }) {
  const total =
    counts.modified +
    counts.added +
    counts.deleted +
    counts.renamed +
    counts.untracked;
  if (total === 0) return null;
  return (
    <span className="inline-flex items-center gap-2 text-2xs">
      {counts.modified > 0 && <Pip color="warning" letter="M" n={counts.modified} />}
      {counts.added > 0 && <Pip color="success" letter="A" n={counts.added} />}
      {counts.deleted > 0 && <Pip color="destructive" letter="D" n={counts.deleted} />}
      {counts.renamed > 0 && <Pip color="info" letter="R" n={counts.renamed} />}
      {counts.untracked > 0 && <Pip color="fg-dim" letter="?" n={counts.untracked} />}
    </span>
  );
}

function Pip({
  color,
  letter,
  n,
}: {
  color: "success" | "warning" | "destructive" | "info" | "fg-dim";
  letter: string;
  n: number;
}) {
  const colorMap: Record<typeof color, string> = {
    success: "text-success",
    warning: "text-warning",
    destructive: "text-destructive",
    info: "text-info",
    "fg-dim": "text-fg-dim",
  };
  return (
    <span className={`inline-flex items-center gap-0.5 font-mono ${colorMap[color]}`}>
      <span className="opacity-70">{letter}</span>
      <span>{n}</span>
    </span>
  );
}

function TabBar({
  active,
  onChange,
  diffCount,
}: {
  active: Tab;
  onChange: (t: Tab) => void;
  diffCount: number;
}) {
  return (
    <nav className="shrink-0 h-9 px-4 sm:px-6 flex items-center gap-0.5 border-b border-border bg-background">
      <TabButton active={active === "source"} onClick={() => onChange("source")}>
        <FolderTree size={12} />
        Source code
      </TabButton>
      <TabButton active={active === "diff"} onClick={() => onChange("diff")}>
        <GitBranch size={12} />
        Diff
        {diffCount > 0 && <CountBadge n={diffCount} active={active === "diff"} />}
      </TabButton>
      <TabButton active={active === "commits"} onClick={() => onChange("commits")}>
        <GitCommit size={12} />
        Commits
      </TabButton>
      <TabButton active={active === "tasks"} onClick={() => onChange("tasks")}>
        <ListChecks size={12} />
        Tasks
      </TabButton>
    </nav>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`relative inline-flex items-center gap-1.5 h-9 px-2.5 -mb-px text-xs transition-colors border-b-2 ${
        active
          ? "text-foreground border-primary"
          : "text-fg-dim border-transparent hover:text-foreground"
      }`}
    >
      {children}
    </button>
  );
}

function CountBadge({ n, active }: { n: number; active: boolean }) {
  return (
    <span
      className={`inline-flex items-center justify-center min-w-[16px] h-[14px] px-1 rounded-full text-2xs font-medium ${
        active
          ? "bg-primary/15 text-primary"
          : "bg-muted text-fg-dim"
      }`}
    >
      {n}
    </span>
  );
}

/* ─────────────────────────── Diff tab ─────────────────────────── */

function DiffTab({ name, onAfterCommit }: { name: string; onAfterCommit: () => void }) {
  const toast = useToast();
  const [diff, setDiff] = useState<string>("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const ac = new AbortController();
    api.appDiff(name, { signal: ac.signal })
      .then((r) => { setDiff(r.diff); setLoading(false); })
      .catch((e) => {
        if (ac.signal.aborted) return;
        setError((e as Error).message);
        setLoading(false);
      });
    return () => ac.abort();
  }, [name, attempt]);

  const refresh = () => {
    // Reset transient state in the event handler so the effect body stays
    // free of cascading setState calls (React 19 lint).
    setLoading(true);
    setError(null);
    setAttempt((a) => a + 1);
  };

  const entries = useMemo<FileDiffEntry[]>(
    () => (diff ? parseUnifiedDiff(diff) : []),
    [diff],
  );
  const tree = useMemo(
    () => (entries.length > 0 ? squashSingleDir(buildFileTree(entries)) : null),
    [entries],
  );
  // Derive default selection instead of mirroring it in an effect: when the
  // user hasn't picked a path yet, fall back to the first entry. Picking a
  // path persists across diff refreshes if it still exists.
  const [pickedPath, setPickedPath] = useState<string | null>(null);
  const selected =
    entries.find((e) => e.path === pickedPath) ?? entries[0] ?? null;
  const selectedPath = selected?.path ?? null;
  const setSelectedPath = setPickedPath;

  // Commit composer state — same shape as the per-run DiffViewer's,
  // pointed at the app-level endpoints instead of the run-scoped ones.
  const [commitMsg, setCommitMsg] = useState("");
  const [committing, setCommitting] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [pushAfter, setPushAfter] = useState(false);

  const generate = useCallback(async () => {
    if (generating) return;
    setGenerating(true);
    try {
      const r = await api.appSuggestCommit(name);
      setCommitMsg(r.message);
    } catch (e) {
      toast("error", `Suggest failed: ${(e as Error).message}`);
    } finally {
      setGenerating(false);
    }
  }, [name, generating, toast]);

  const commit = useCallback(async () => {
    const msg = commitMsg.trim();
    if (!msg || committing) return;
    setCommitting(true);
    try {
      const r = await api.appCommit(name, { message: msg, push: pushAfter });
      if (!r.ok) {
        toast("error", r.error ? `${r.message}: ${r.error}` : r.message);
        return;
      }
      toast("success", r.message);
      setCommitMsg("");
      setAttempt((a) => a + 1);
      onAfterCommit();
    } catch (e) {
      toast("error", (e as Error).message);
    } finally {
      setCommitting(false);
    }
  }, [name, commitMsg, committing, pushAfter, toast, onAfterCommit]);

  const canCommit = !!commitMsg.trim() && !committing && entries.length > 0;
  const isEmpty = !loading && !error && diff.trim().length === 0;

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Commit composer */}
      <div className="border-b border-border bg-background p-2 space-y-1.5">
        <div className="relative">
          <textarea
            value={commitMsg}
            onChange={(e) => setCommitMsg(e.target.value)}
            placeholder={
              entries.length === 0
                ? "Nothing to commit"
                : `Message (Ctrl+Enter to commit) — ${entries.length} file${entries.length === 1 ? "" : "s"} changed`
            }
            disabled={entries.length === 0 || committing}
            rows={2}
            onKeyDown={(e) => {
              if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
                e.preventDefault();
                if (canCommit) void commit();
              }
            }}
            className="w-full bg-transparent border border-border rounded px-2 py-1.5 pr-8 text-[12px] resize-none focus:outline-none focus:border-primary/60 placeholder:text-muted-foreground/70 disabled:opacity-50"
          />
          <button
            type="button"
            onClick={generate}
            disabled={generating || entries.length === 0}
            className="absolute right-1.5 top-1.5 inline-flex items-center justify-center h-6 w-6 rounded text-fg-dim hover:text-primary hover:bg-primary/10 disabled:opacity-40 disabled:cursor-not-allowed"
            title="Auto-generate message from diff"
            aria-label="Generate commit message"
          >
            {generating ? <Loader2 size={13} className="animate-spin" /> : <Sparkles size={13} />}
          </button>
        </div>
        <div className="flex items-center gap-2">
          <label className="inline-flex items-center gap-1.5 text-[11px] text-fg-dim cursor-pointer select-none">
            <input
              type="checkbox"
              checked={pushAfter}
              onChange={(e) => setPushAfter(e.target.checked)}
              className="h-3 w-3 rounded border-border accent-primary"
            />
            Push after commit
          </label>
          <Button variant="ghost" size="sm" onClick={refresh} disabled={loading}>
            <RefreshCw size={13} className={loading ? "animate-spin" : ""} />
            Refresh
          </Button>
          <Button size="sm" onClick={commit} disabled={!canCommit} className="ml-auto">
            {committing ? <Loader2 size={13} className="animate-spin" /> : <GitCommit size={13} />}
            Commit
          </Button>
        </div>
      </div>

      {/* Tree + hunks */}
      <div className="flex-1 min-h-0 grid grid-cols-[minmax(220px,32%)_1fr] overflow-hidden">
        <aside className="min-h-0 overflow-auto border-r border-border bg-background">
          {loading && (
            <div className="p-3 space-y-2">
              <div className="h-3 w-3/4 rounded bg-muted/60 animate-pulse" />
              <div className="h-3 w-2/3 rounded bg-muted/60 animate-pulse" />
            </div>
          )}
          {!loading && tree && (
            <FileTreeView tree={tree} selectedPath={selectedPath} onSelect={setSelectedPath} />
          )}
          {!loading && !error && entries.length === 0 && (
            <div className="p-4 text-[11px] text-muted-foreground italic">
              No uncommitted changes.
            </div>
          )}
        </aside>
        <div className="min-h-0 overflow-auto bg-background">
          {error && (
            <div className="p-4 text-destructive text-sm font-mono">{error}</div>
          )}
          {isEmpty && (
            <div className="p-6 text-sm text-muted-foreground text-center">
              No uncommitted changes in the working tree.
            </div>
          )}
          {selected && !loading && !error && <FileDiffPane entry={selected} />}
        </div>
      </div>
    </div>
  );
}

/* ─────────────────────────── Commits tab ─────────────────────────── */

function CommitsTab({ name }: { name: string }) {
  const [commits, setCommits] = useState<CommitEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const ac = new AbortController();
    api.appLog(name, 50, { signal: ac.signal })
      .then((r) => { setCommits(r.commits); setLoading(false); })
      .catch((e) => {
        if (ac.signal.aborted) return;
        setError((e as Error).message);
        setLoading(false);
      });
    return () => ac.abort();
  }, [name]);

  if (loading) {
    return (
      <div className="p-4 space-y-2">
        <div className="h-4 w-2/3 rounded bg-muted/60 animate-pulse" />
        <div className="h-4 w-1/2 rounded bg-muted/60 animate-pulse" />
        <div className="h-4 w-3/4 rounded bg-muted/60 animate-pulse" />
      </div>
    );
  }
  if (error) {
    return <div className="p-4 text-destructive text-sm font-mono">{error}</div>;
  }
  if (commits.length === 0) {
    return <div className="p-4 text-fg-dim italic text-sm">No commits yet.</div>;
  }
  return (
    <ul className="overflow-auto h-full divide-y divide-border">
      {commits.map((c) => (
        <li key={c.sha} className="px-4 py-2 hover:bg-accent/40 transition-colors">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-mono text-[11px] text-info shrink-0">{c.shortSha}</span>
            <span className="text-sm font-medium truncate flex-1 min-w-0">{c.subject}</span>
            <span className="text-[10px] text-fg-dim font-mono shrink-0" title={c.email}>
              {c.author}
            </span>
            <span className="text-[10px] text-fg-dim shrink-0">
              {relativeTime(new Date(c.at * 1000).toISOString())}
            </span>
          </div>
        </li>
      ))}
    </ul>
  );
}

/* ─────────────────────────── Tasks tab ─────────────────────────── */

/**
 * Tasks scoped to this app. Replaces the previous "Tasks" link in the
 * tab nav that took the operator off to /tasks?app=<name> — keeping it
 * inline preserves the page context and lets the operator triage a
 * task without losing their diff/terminal state.
 *
 * Rendering: same kanban-section discipline as the main /tasks page —
 * "Doing" / "Todo" / "Done" / "Blocked" buckets with count badges.
 * Each row links into the dedicated task detail page on click.
 */
function TasksTab({ name }: { name: string }) {
  const [tasks, setTasks] = useState<Task[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .tasks()
      .then((r) => {
        if (cancelled) return;
        setTasks(r.filter((t) => t.app === name));
      })
      .catch((e) => {
        if (cancelled) return;
        setError((e as Error).message);
      });
    return () => {
      cancelled = true;
    };
  }, [name]);

  if (error) {
    return <div className="p-6 text-sm text-destructive font-mono">{error}</div>;
  }
  if (!tasks) {
    return (
      <div className="p-6 space-y-2">
        <div className="h-4 w-1/2 rounded bg-muted/60 animate-pulse" />
        <div className="h-4 w-2/3 rounded bg-muted/60 animate-pulse" />
        <div className="h-4 w-1/3 rounded bg-muted/60 animate-pulse" />
      </div>
    );
  }
  if (tasks.length === 0) {
    return (
      <div className="p-8 text-center">
        <ListChecks size={32} className="mx-auto mb-3 text-fg-dim/40" />
        <p className="text-sm text-fg-dim mb-1">No tasks pinned to this app yet.</p>
        <Link
          href="/tasks"
          className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
        >
          Create one →
        </Link>
      </div>
    );
  }
  // Group by section and render in a fixed order. Newest first within
  // each section (tasks already arrive in id-desc order from the API).
  const sections: Array<{ key: string; label: string; items: Task[] }> = [
    { key: SECTION_DOING, label: "In progress", items: tasks.filter((t) => t.section === SECTION_DOING) },
    { key: SECTION_TODO, label: "Todo", items: tasks.filter((t) => t.section === SECTION_TODO) },
    { key: SECTION_BLOCKED, label: "Blocked", items: tasks.filter((t) => t.section === SECTION_BLOCKED) },
    { key: SECTION_DONE, label: "Done", items: tasks.filter((t) => t.section === SECTION_DONE) },
  ];
  return (
    <div className="h-full overflow-auto px-6 py-4 space-y-6">
      {sections.map((s) =>
        s.items.length > 0 ? (
          <section key={s.key}>
            <h2 className="text-2xs font-semibold uppercase tracking-wider text-fg-dim mb-2">
              {s.label}
              <span className="ml-1.5 font-normal opacity-70">{s.items.length}</span>
            </h2>
            <ul className="divide-y divide-border/60 border border-border/60 rounded-lg overflow-hidden bg-card/30">
              {s.items.map((t) => (
                <li key={t.id}>
                  <Link
                    href={`/tasks/${t.id}`}
                    className="block px-3 py-2.5 hover:bg-accent/50 transition-colors"
                  >
                    <div className="flex items-center gap-2 text-sm">
                      <span className="font-mono text-2xs text-fg-dim shrink-0">{t.id}</span>
                      <span
                        className={`flex-1 min-w-0 truncate ${
                          t.checked
                            ? "line-through text-fg-dim"
                            : "text-foreground"
                        }`}
                      >
                        {t.title}
                      </span>
                    </div>
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        ) : null,
      )}
    </div>
  );
}

/* ─────────────────────────── Terminal panel ─────────────────────────── */

interface TerminalEntry {
  id: number;
  command: string;
  pending: boolean;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  durationMs?: number;
  timedOut?: boolean;
  truncated?: boolean;
}

function TerminalPanel({
  name,
  open,
  height,
  minHeight,
  barHeight,
  onToggle,
  onResize,
  onMaybeChangedRepo,
}: {
  name: string;
  open: boolean;
  height: number;
  minHeight: number;
  barHeight: number;
  onToggle: () => void;
  onResize: (next: number) => void;
  onMaybeChangedRepo: () => void;
}) {
  const [history, setHistory] = useState<TerminalEntry[]>([]);
  const [draft, setDraft] = useState("");
  const [recall, setRecall] = useState<{ index: number; backup: string } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const idCounter = useRef(0);
  // Drag state for the resize handle. Tracked in a ref so the
  // pointermove handler doesn't trigger React re-renders 60×/sec.
  const dragRef = useRef<{ startY: number; startHeight: number } | null>(null);

  /**
   * Pointer-driven resize. Pointermove updates `height` directly via
   * onResize; the parent's setState is the only re-render path. Caps
   * to [minHeight, viewportHeight - 260] so the terminal can't swallow
   * the global nav, app header, and tab bar.
   */
  const onHandlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!open) return;
    e.preventDefault();
    const start = { startY: e.clientY, startHeight: height };
    dragRef.current = start;
    const target = e.currentTarget;
    target.setPointerCapture(e.pointerId);
    const onMove = (ev: PointerEvent) => {
      const d = dragRef.current;
      if (!d) return;
      const delta = d.startY - ev.clientY;
      const max = window.innerHeight - 260;
      const next = Math.max(minHeight, Math.min(max, d.startHeight + delta));
      onResize(next);
    };
    const onUp = () => {
      dragRef.current = null;
      target.releasePointerCapture(e.pointerId);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  // Auto-scroll the output to the latest entry. We do this on
  // history mutations rather than per-keystroke so typing in the
  // input field doesn't fight the scroll position.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [history]);

  const submit = useCallback(async () => {
    const cmd = draft.trim();
    if (!cmd) return;
    const id = ++idCounter.current;
    setHistory((h) => [
      ...h,
      { id, command: cmd, pending: true, stdout: "", stderr: "", exitCode: null },
    ]);
    setDraft("");
    setRecall(null);
    try {
      const r = await api.appExec(name, cmd);
      setHistory((h) =>
        h.map((e) =>
          e.id === id
            ? {
                ...e,
                pending: false,
                stdout: r.stdout,
                stderr: r.stderr,
                exitCode: r.exitCode,
                durationMs: r.durationMs,
                timedOut: r.timedOut,
                truncated: r.truncated,
              }
            : e,
        ),
      );
      onMaybeChangedRepo();
    } catch (e) {
      setHistory((h) =>
        h.map((entry) =>
          entry.id === id
            ? {
                ...entry,
                pending: false,
                stderr: (e as Error).message,
                exitCode: -1,
              }
            : entry,
        ),
      );
    }
  }, [draft, name, onMaybeChangedRepo]);

  // History recall — Up / Down arrow walks past commands, like a
  // real shell. Backs up the in-progress draft so navigating back
  // to "present" restores it.
  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      void submit();
      return;
    }
    if (e.key === "ArrowUp") {
      const cmds = history.map((h) => h.command);
      if (cmds.length === 0) return;
      e.preventDefault();
      const nextIdx = recall ? Math.max(0, recall.index - 1) : cmds.length - 1;
      const backup = recall ? recall.backup : draft;
      setRecall({ index: nextIdx, backup });
      setDraft(cmds[nextIdx]);
      return;
    }
    if (e.key === "ArrowDown" && recall) {
      e.preventDefault();
      const cmds = history.map((h) => h.command);
      const nextIdx = recall.index + 1;
      if (nextIdx >= cmds.length) {
        setDraft(recall.backup);
        setRecall(null);
      } else {
        setDraft(cmds[nextIdx]);
        setRecall({ index: nextIdx, backup: recall.backup });
      }
    }
  };

  const clear = () => {
    setHistory([]);
    setRecall(null);
    inputRef.current?.focus();
  };

  // Compute the dock's outer height: when collapsed, just the bar;
  // when open, bar + body. The relative wrapper hosts the absolute
  // resize handle straddling the top edge.
  const outerHeight = open ? barHeight + height : barHeight;

  return (
    <section
      className="relative shrink-0 flex flex-col bg-background border-t border-border"
      style={{ height: outerHeight }}
    >
      {open && (
        <div
          role="separator"
          aria-orientation="horizontal"
          aria-label="Resize terminal"
          onPointerDown={onHandlePointerDown}
          className="absolute -mt-1 h-2 w-full cursor-ns-resize z-10 hover:bg-primary/20 transition-colors"
          style={{ top: 0 }}
        />
      )}
      <header
        className="shrink-0 flex items-center gap-2 px-4 bg-card/40 text-2xs text-fg-dim cursor-pointer select-none hover:bg-card/60 transition-colors"
        style={{ height: barHeight }}
        onClick={onToggle}
        role="button"
        aria-expanded={open}
        aria-label={open ? "Collapse terminal" : "Expand terminal"}
      >
        <ChevronDown
          size={12}
          className={`transition-transform ${open ? "rotate-0" : "-rotate-90"}`}
        />
        <TerminalIcon size={12} />
        <span className="font-mono uppercase tracking-wider">Terminal</span>
        {history.length > 0 && (
          <span className="text-2xs opacity-70">
            · {history.length} command{history.length === 1 ? "" : "s"}
          </span>
        )}
        {open && history.length > 0 && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              clear();
            }}
            className="ml-auto text-2xs hover:text-foreground"
            title="Clear scrollback"
          >
            clear
          </button>
        )}
        {!open && history.length === 0 && (
          <span className="ml-auto text-2xs opacity-60">click to expand</span>
        )}
      </header>

      {open && (
      <>
      <div ref={scrollRef} className="flex-1 min-h-0 overflow-auto p-2 font-mono text-xs leading-snug space-y-2">
        {history.length === 0 ? (
          <p className="text-fg-dim italic px-1">
            Run shell commands inside this app&apos;s working tree. 30s timeout, 1 MB output cap, basic foot-gun blocklist.
          </p>
        ) : (
          history.map((entry) => (
            <div key={entry.id} className="space-y-0.5">
              <div className="flex items-center gap-1.5">
                <span className="text-success shrink-0">$</span>
                <span className="text-foreground truncate">{entry.command}</span>
                {entry.pending ? (
                  <Loader2 size={11} className="text-primary animate-spin shrink-0 ml-auto" />
                ) : (
                  <span className="ml-auto flex items-center gap-1.5 text-[10px] text-fg-dim shrink-0">
                    {entry.timedOut && <span className="text-warning">timeout</span>}
                    {entry.truncated && <span className="text-warning">trunc</span>}
                    <span
                      className={
                        entry.exitCode === 0
                          ? "text-success"
                          : entry.exitCode === null
                            ? "text-warning"
                            : "text-destructive"
                      }
                    >
                      exit {entry.exitCode ?? "?"}
                    </span>
                    {entry.durationMs !== undefined && (
                      <span>{entry.durationMs}ms</span>
                    )}
                  </span>
                )}
              </div>
              {entry.stdout && (
                <pre className="whitespace-pre-wrap wrap-break-word text-foreground/85 pl-3">
                  {entry.stdout}
                </pre>
              )}
              {entry.stderr && (
                <pre className="whitespace-pre-wrap wrap-break-word text-destructive/85 pl-3">
                  {entry.stderr}
                </pre>
              )}
            </div>
          ))
        )}
      </div>

      <form
        onSubmit={(e) => { e.preventDefault(); void submit(); }}
        className="flex items-center gap-1.5 px-2 py-1.5 border-t border-border"
      >
        <span className="text-success font-mono text-xs shrink-0">$</span>
        <input
          ref={inputRef}
          value={draft}
          onChange={(e) => { setDraft(e.target.value); setRecall(null); }}
          onKeyDown={onKeyDown}
          placeholder="type a shell command (Enter to run, ↑↓ for history)"
          className="flex-1 bg-transparent border-0 outline-none font-mono text-xs placeholder:text-muted-foreground/70"
          spellCheck={false}
          autoComplete="off"
        />
        <Button type="submit" size="iconSm" disabled={!draft.trim()} title="Run (Enter)">
          <Send size={13} />
        </Button>
      </form>
      </>
      )}
    </section>
  );
}
