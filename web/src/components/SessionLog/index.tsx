// SessionLog v1 — pragmatic port of main's transcript viewer.
//
// What this version does:
//   - polls /tail?since=<offset> every 1.5 s for new lines
//   - paginates backwards via /tail?before=<offset> on scroll-up
//   - renders user / assistant / tool_use / tool_result rows
//   - shows attachments, strips system tags, prettifies MCP tool names
//   - sticky-bottom autoscroll (until the user scrolls up)
//   - toolbar: search, copy-all, download as .md, kill, rewind to last
//     user turn
//
// What it skips for v1 (defer until we need them):
//   - streaming token partials (partialsStore is a no-op shim today —
//     wire up real SSE deltas once the bridge endpoint is ported)
//   - syntax highlighting / markdown rendering of assistant text
//   - per-line virtualization (cap at MAX_RENDERED instead)
//   - rich diff viewer (TaskDetail still owns AgentTree without it)

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  ArrowDown,
  Copy,
  Download,
  RotateCcw,
  Search,
  Square,
  X,
} from "lucide-react";
import { api } from "@/api/client";
import { useToast } from "@/components/Toasts";
import { useConfirm } from "@/components/ConfirmProvider";
import {
  useKillSession,
  useRewindSession,
} from "@/api/queries";
import { cn } from "@/lib/cn";
import { LogRow } from "./views";
import {
  classify,
  exportMarkdown,
  MAX_RENDERED,
  type LogEntry,
} from "./helpers";
import type { SessionMessage } from "@/api/types";

interface Props {
  sessionId: string | undefined;
  repo: string | undefined;
  /** Visual role badge for the header — e.g. "coder", "orphan". */
  role?: string;
  /** Optional title shown in the header. Defaults to the session id slice. */
  title?: string;
  /** Hide the kill-session toolbar action (used inside TaskDetail
   *  where the per-run kill lives in AgentTree). */
  hideKill?: boolean;
}

const POLL_MS = 1_500;

export function SessionLog({ sessionId, repo, role, title, hideKill }: Props) {
  const toast = useToast();
  const confirm = useConfirm();
  const killMut = useKillSession();
  const rewindMut = useRewindSession();

  const [entries, setEntries] = useState<LogEntry[]>([]);
  const [offset, setOffset] = useState(0);
  const [headOffset, setHeadOffset] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [showSearch, setShowSearch] = useState(false);

  const scrollRef = useRef<HTMLDivElement>(null);
  const stickyBottomRef = useRef(true);

  // Reset on session change. Keep the entries[] empty so the new
  // session's lines don't render under the previous head.
  useEffect(() => {
    setEntries([]);
    setOffset(0);
    setHeadOffset(null);
    setError(null);
    stickyBottomRef.current = true;
  }, [sessionId, repo]);

  // Poll forward for new lines.
  useEffect(() => {
    if (!sessionId || !repo) return;
    let cancelled = false;
    const tick = async () => {
      if (cancelled) return;
      try {
        const data = await api.sessions.tail(sessionId, repo, offset);
        if (cancelled) return;
        if (data.lines && data.lines.length > 0) {
          setEntries((prev) => [...prev, ...(data.lines as LogEntry[])]);
          setOffset(data.offset);
          if (headOffset === null && data.lineOffsets.length > 0) {
            setHeadOffset(data.lineOffsets[0]);
          }
        } else if (offset === 0) {
          // First tick on an empty session — record the offset cursor
          // so we don't refetch the same head every poll.
          setOffset(data.offset);
        }
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      }
    };
    void tick();
    const h = setInterval(tick, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(h);
    };
  }, [sessionId, repo, offset, headOffset]);

  // Auto-scroll to bottom on new lines unless user scrolled up.
  useEffect(() => {
    if (!stickyBottomRef.current) return;
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [entries.length]);

  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
    stickyBottomRef.current = nearBottom;
  }, []);

  const loadOlder = useCallback(async () => {
    if (!sessionId || !repo || headOffset === null || headOffset <= 0) return;
    if (loading) return;
    setLoading(true);
    try {
      const data = await api.sessions.tailBefore(sessionId, repo, headOffset);
      if (data.lines && data.lines.length > 0) {
        setEntries((prev) => [...(data.lines as LogEntry[]), ...prev]);
        setHeadOffset(data.beforeOffset);
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [sessionId, repo, headOffset, loading]);

  const lastUserUuid = useMemo(() => {
    for (let i = entries.length - 1; i >= 0; i--) {
      if (classify(entries[i]) === "user" && entries[i].uuid)
        return entries[i].uuid as string;
    }
    return null;
  }, [entries]);

  const filtered = useMemo(() => {
    const list = entries.length > MAX_RENDERED
      ? entries.slice(entries.length - MAX_RENDERED)
      : entries;
    const q = search.trim().toLowerCase();
    if (!q) return list;
    return list.filter((e) => {
      const blob = JSON.stringify(e.message?.content ?? "").toLowerCase();
      return blob.includes(q);
    });
  }, [entries, search]);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(exportMarkdown(entries));
      toast.success("copied", "transcript on clipboard");
    } catch {
      toast.error("copy failed");
    }
  };

  const handleDownload = () => {
    const blob = new Blob([exportMarkdown(entries)], {
      type: "text/markdown",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${sessionId ?? "session"}.md`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleKill = async () => {
    if (!sessionId) return;
    const ok = await confirm({
      title: "kill session?",
      description:
        "the running claude process is terminated. session jsonl stays.",
      confirmLabel: "kill",
      variant: "destructive",
    });
    if (!ok) return;
    try {
      await killMut.mutateAsync(sessionId);
      toast.success("killed");
    } catch (e) {
      toast.error("kill failed", (e as Error).message);
    }
  };

  const handleRewind = useCallback(
    async (uuid?: string) => {
      if (!sessionId || !repo) return;
      const target = uuid ?? lastUserUuid;
      if (!target) {
        toast.warning("nothing to rewind");
        return;
      }
      const ok = await confirm({
        title: "rewind session?",
        description: `drop every entry after the chosen turn. cannot be undone.`,
        confirmLabel: "rewind",
        variant: "destructive",
      });
      if (!ok) return;
      try {
        const r = await rewindMut.mutateAsync({
          sessionId,
          body: { repo, uuid: target },
        });
        toast.success(`kept ${r.kept}`, `dropped ${r.dropped}`);
        // Reset state so the next poll re-reads the truncated file.
        setEntries([]);
        setOffset(0);
        setHeadOffset(null);
      } catch (e) {
        toast.error("rewind failed", (e as Error).message);
      }
    },
    [sessionId, repo, lastUserUuid, rewindMut, toast, confirm],
  );

  if (!sessionId || !repo) {
    return (
      <div className="flex h-full items-center justify-center px-6 py-12 font-mono text-micro uppercase tracking-wideish text-muted-2">
        select a session to view its transcript.
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Header */}
      <header className="flex shrink-0 items-center gap-3 border-b border-border bg-surface px-4 py-2">
        <span className="font-mono text-micro uppercase tracking-wideish text-muted">
          session
        </span>
        <span className="truncate font-mono text-micro text-fg">
          {title ?? sessionId.slice(0, 8)}
        </span>
        {role && (
          <span className="rounded-sm border border-accent/30 bg-accent/10 px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wideish text-accent">
            {role}
          </span>
        )}
        <span className="ml-auto flex items-center gap-1">
          <ToolbarBtn
            icon={<Search size={12} />}
            label="search"
            onClick={() => setShowSearch((v) => !v)}
            active={showSearch}
          />
          <ToolbarBtn
            icon={<Copy size={12} />}
            label="copy"
            onClick={handleCopy}
          />
          <ToolbarBtn
            icon={<Download size={12} />}
            label="md"
            onClick={handleDownload}
          />
          <ToolbarBtn
            icon={<RotateCcw size={12} />}
            label="rewind"
            onClick={() => void handleRewind()}
            disabled={!lastUserUuid}
          />
          {!hideKill && (
            <ToolbarBtn
              icon={<Square size={12} />}
              label="kill"
              onClick={() => void handleKill()}
              tone="danger"
            />
          )}
        </span>
      </header>

      {showSearch && (
        <div className="shrink-0 border-b border-border bg-surface-2 px-4 py-2">
          <div className="relative">
            <Search
              size={12}
              className="absolute left-2 top-1/2 -translate-y-1/2 text-muted-2"
            />
            <input
              autoFocus
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="filter transcript…"
              className="w-full rounded-sm border border-border bg-bg pl-7 pr-7 py-1 font-mono text-micro text-fg focus:border-accent focus:outline-none"
            />
            {search && (
              <button
                type="button"
                onClick={() => setSearch("")}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-2 hover:text-fg"
                aria-label="clear search"
              >
                <X size={11} />
              </button>
            )}
          </div>
        </div>
      )}

      {error && (
        <div className="shrink-0 border-b border-border bg-status-blocked/10 px-4 py-2 font-mono text-micro text-status-blocked">
          {error}
        </div>
      )}

      {/* Scroll body */}
      <div
        ref={scrollRef}
        onScroll={onScroll}
        className="relative flex-1 min-h-0 overflow-y-auto"
      >
        {headOffset !== null && headOffset > 0 && (
          <div className="flex justify-center px-4 py-2">
            <button
              type="button"
              onClick={() => void loadOlder()}
              disabled={loading}
              className="rounded-sm border border-border bg-surface px-3 py-1 font-mono text-micro uppercase tracking-wideish text-muted hover:border-accent/40 hover:text-accent disabled:opacity-50"
            >
              {loading ? "loading…" : "load earlier"}
            </button>
          </div>
        )}
        {entries.length === 0 ? (
          <div className="flex h-full items-center justify-center font-mono text-micro uppercase tracking-wideish text-muted-2">
            no messages yet — type below to start the conversation.
          </div>
        ) : (
          <div className="py-2">
            {filtered.map((e, i) => (
              <LogRow
                entry={e}
                sessionId={sessionId}
                onRewind={(uuid) => void handleRewind(uuid)}
                key={(e.uuid as string | undefined) ?? `idx-${i}`}
              />
            ))}
          </div>
        )}
      </div>

      {!stickyBottomRef.current && entries.length > 0 && (
        <button
          type="button"
          onClick={() => {
            stickyBottomRef.current = true;
            const el = scrollRef.current;
            if (el) el.scrollTop = el.scrollHeight;
          }}
          className="absolute bottom-16 right-6 inline-flex items-center gap-1 rounded-full border border-border bg-surface px-3 py-1.5 font-mono text-micro uppercase tracking-wideish text-muted shadow-lg hover:border-accent/40 hover:text-accent"
        >
          <ArrowDown size={11} />
          jump to latest
        </button>
      )}
    </div>
  );
}

function ToolbarBtn({
  icon,
  label,
  onClick,
  active,
  disabled,
  tone = "default",
}: {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
  active?: boolean;
  disabled?: boolean;
  tone?: "default" | "danger";
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-sm border px-2 py-1 font-mono text-micro uppercase tracking-wideish transition-colors disabled:opacity-40",
        tone === "danger"
          ? "border-status-blocked/30 text-status-blocked hover:bg-status-blocked/10"
          : active
            ? "border-accent bg-accent/10 text-accent"
            : "border-border text-muted hover:border-border-strong hover:text-fg",
      )}
      title={label}
    >
      {icon}
      <span>{label}</span>
    </button>
  );
}

// Re-exported for callers that want to pre-classify a list.
export type { LogEntry, SessionMessage };
