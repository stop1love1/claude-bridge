"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import {
  ArrowLeft,
  Folder,
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
import { Button } from "./ui/button";
import { useToast } from "./Toasts";
import { relativeTime } from "@/libs/client/time";

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

type Tab = "diff" | "commits";

/**
 * App detail page — git management + uncommitted diff + an inline
 * terminal for one-shot shell commands.
 *
 * Layout: sticky header on top, two-tab body in the middle (Diff /
 * Commits), and a fixed-height terminal pane along the bottom. The
 * terminal stays visible while the user navigates tabs so they can
 * run a command without losing the diff context.
 */
export function AppDetail({ name }: { name: string }) {
  const [status, setStatus] = useState<StatusPayload | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("diff");

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
    <div className="flex flex-col h-screen overflow-hidden">
      <AppHeader
        name={name}
        status={status}
        error={statusError}
        onRefresh={reloadStatus}
      />

      <div className="flex-1 min-h-0 grid grid-rows-[1fr_320px]">
        {/* Top half: tabs + active tab content. */}
        <main className="min-h-0 flex flex-col overflow-hidden border-b border-border">
          <nav className="flex items-center gap-1 px-3 py-1.5 border-b border-border bg-card/40">
            <TabButton active={tab === "diff"} onClick={() => setTab("diff")}>
              <GitBranch size={12} />
              Diff
              {status && !status.clean && (
                <span className="inline-flex items-center justify-center min-w-[16px] h-[14px] px-1 rounded-full bg-primary/20 text-primary text-[9px] font-bold">
                  {status.counts.modified +
                    status.counts.added +
                    status.counts.deleted +
                    status.counts.renamed +
                    status.counts.untracked}
                </span>
              )}
            </TabButton>
            <TabButton active={tab === "commits"} onClick={() => setTab("commits")}>
              <GitCommit size={12} />
              Commits
            </TabButton>
            <Link
              href={`/tasks?app=${encodeURIComponent(name)}`}
              className="ml-auto inline-flex items-center gap-1.5 px-2 py-1 rounded-md text-xs text-fg-dim hover:text-foreground hover:bg-accent transition-colors"
              title="View related tasks"
            >
              <ListChecks size={12} />
              Tasks
            </Link>
          </nav>
          <div className="flex-1 min-h-0 overflow-hidden">
            {tab === "diff" && (
              <DiffTab name={name} onAfterCommit={reloadStatus} />
            )}
            {tab === "commits" && (
              <CommitsTab name={name} />
            )}
          </div>
        </main>

        {/* Bottom: terminal. Fixed height so the operator always knows
            where it lives and the diff above doesn't reflow when
            output expands. */}
        <TerminalPanel name={name} onMaybeChangedRepo={() => {
          // Most commands the operator runs (git pull, git checkout,
          // pnpm install creating a lockfile diff…) plausibly mutate
          // the working tree. Refresh the header status after every
          // command so badges stay honest.
          reloadStatus();
        }} />
      </div>
    </div>
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
      className={`inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs transition-colors ${
        active
          ? "bg-primary/10 text-primary"
          : "text-fg-dim hover:text-foreground hover:bg-accent"
      }`}
    >
      {children}
    </button>
  );
}

function AppHeader({
  name,
  status,
  error,
  onRefresh,
}: {
  name: string;
  status: StatusPayload | null;
  error: string | null;
  onRefresh: () => void;
}) {
  return (
    <header className="border-b border-border bg-card px-4 py-3">
      <div className="flex items-center gap-3 flex-wrap">
        <Link
          href="/apps"
          className="inline-flex items-center gap-1 text-fg-dim hover:text-foreground text-xs"
          title="Back to Apps"
        >
          <ArrowLeft size={13} />
          Apps
        </Link>
        <Folder size={16} className="text-primary shrink-0" />
        <span className="font-mono text-sm font-semibold">{name}</span>
        {status?.branch && (
          <span
            className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full bg-secondary border border-border text-[10px] font-mono"
            title={status.upstream ?? "no upstream"}
          >
            <GitBranch size={9} className="opacity-70" />
            {status.branch}
          </span>
        )}
        {status && (status.ahead > 0 || status.behind > 0) && (
          <span className="text-[10px] text-fg-dim font-mono" title="ahead / behind upstream">
            {status.ahead > 0 && <span className="text-success">↑{status.ahead}</span>}
            {status.behind > 0 && <span className="text-warning">↓{status.behind}</span>}
          </span>
        )}
        {status && !status.clean && (
          <span className="inline-flex items-center gap-2 text-[10px] font-mono">
            {status.counts.modified > 0 && (
              <span className="text-yellow-400">M{status.counts.modified}</span>
            )}
            {status.counts.added > 0 && (
              <span className="text-success">A{status.counts.added}</span>
            )}
            {status.counts.deleted > 0 && (
              <span className="text-destructive">D{status.counts.deleted}</span>
            )}
            {status.counts.renamed > 0 && (
              <span className="text-info">R{status.counts.renamed}</span>
            )}
            {status.counts.untracked > 0 && (
              <span className="text-fg-dim">?{status.counts.untracked}</span>
            )}
          </span>
        )}
        {status && status.clean && (
          <span className="text-[10px] text-success font-mono">clean</span>
        )}
        <span className="ml-auto flex items-center gap-2">
          {status && (
            <span
              className="text-[11px] text-fg-dim font-mono truncate max-w-[480px]"
              title={status.cwd}
            >
              {status.cwd}
            </span>
          )}
          <Button variant="ghost" size="iconSm" onClick={onRefresh} title="Refresh status">
            <RefreshCw size={13} />
          </Button>
        </span>
      </div>
      {error && (
        <p className="mt-2 text-[11px] text-destructive font-mono">{error}</p>
      )}
    </header>
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
  onMaybeChangedRepo,
}: {
  name: string;
  onMaybeChangedRepo: () => void;
}) {
  const [history, setHistory] = useState<TerminalEntry[]>([]);
  const [draft, setDraft] = useState("");
  const [recall, setRecall] = useState<{ index: number; backup: string } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const idCounter = useRef(0);

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

  return (
    <section className="flex flex-col min-h-0 bg-background">
      <header className="flex items-center gap-2 px-3 py-1.5 border-b border-border bg-card/40 text-[11px] text-fg-dim">
        <TerminalIcon size={12} />
        <span className="font-mono uppercase tracking-wider">Terminal</span>
        <span className="ml-auto flex items-center gap-2">
          <span className="text-[10px]">
            {history.length} command{history.length === 1 ? "" : "s"}
          </span>
          <button
            type="button"
            onClick={clear}
            disabled={history.length === 0}
            className="text-[10px] hover:text-foreground disabled:opacity-40"
            title="Clear scrollback"
          >
            clear
          </button>
        </span>
      </header>

      <div ref={scrollRef} className="flex-1 min-h-0 overflow-auto p-2 font-mono text-[11.5px] leading-snug space-y-2">
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
          className="flex-1 bg-transparent border-0 outline-none font-mono text-[12px] placeholder:text-muted-foreground/70"
          spellCheck={false}
          autoComplete="off"
        />
        <Button type="submit" size="iconSm" disabled={!draft.trim()} title="Run (Enter)">
          <Send size={13} />
        </Button>
      </form>
    </section>
  );
}
