// SessionLog v2 — pragmatic port of main's transcript viewer.
//
// What this version does:
//   - polls /tail?since=<offset> every 1.5 s for new lines
//   - paginates backwards via /tail?before=<offset> on scroll-up + auto
//     fetch when scrollTop drops below 32px
//   - scroll-restore: prepend keeps the existing tail in place via a
//     useLayoutEffect hand-off (no jump)
//   - markdown-rendered assistant text (react-markdown + remark-gfm)
//   - per-tool views: Bash / TodoWrite / Skill, generic JSON for the rest
//   - inline base64 image previews + repo-relative ImageRefLink
//   - sticky pinned-user header (most recent user msg above the fold)
//   - search-in-log w/ <mark> highlights, prev/next + Cmd+F intercept
//   - ActivityRow heuristic (last entry is tool_use w/ no result, < 60s)
//   - "… N earlier entries trimmed" pill at top when over MAX_RENDERED
//   - ai-title session header + stable entry keys (uuid → message.id →
//     timestamp:type → pos-N)
//
// What this version still skips (defer until backend lands):
//   - SSE-driven streaming partials (partialsStore is a no-op shim)
//   - syntax highlighting inside fenced code blocks

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  ArrowDown,
  ArrowUp,
  Check,
  Copy,
  Download,
  MoreVertical,
  RotateCw,
  Search,
  Terminal,
  Wrench,
  X,
} from "lucide-react";
import { api } from "@/api/client";
import { useToast } from "@/components/Toasts";
import { useConfirm } from "@/components/ConfirmProvider";
import {
  useKillSession,
  useRewindSession,
} from "@/api/queries";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/cn";
import { ActivityRow, LogRow } from "./views";
import {
  asBlocks,
  classify,
  exportMarkdown,
  extractAttachments,
  MAX_RENDERED,
  stripSystemTags,
  type ContentBlock,
  type LogEntry,
} from "./helpers";
import type { SessionMessage } from "@/api/types";
import { InlinePermissionRequests } from "@/components/InlinePermissionRequests";
import { TokenUsage, type TokenTotals } from "@/components/TokenUsage";

interface Props {
  sessionId: string | undefined;
  repo: string | undefined;
  /** Visual role badge for the header — e.g. "coder", "orphan". */
  role?: string;
  /** Optional title shown in the header. Defaults to the session id slice
   *  (or to whatever `ai-title` Claude wrote into the .jsonl). */
  title?: string;
  /** Hide the kill-session toolbar action (used inside TaskDetail
   *  where the per-run kill lives in AgentTree). */
  hideKill?: boolean;
  /**
   * Optional handler — when provided, surfaces a `Clear` button in the
   * header and a `Clear conversation` row in the mobile kebab.
   */
  onClearConversation?: () => void;
  /**
   * Optional composer slot. When provided, mounts the node inside the
   * sticky bottom strip beneath the transcript. Standalone surfaces
   * (e.g. the /sessions browser) omit this and host the composer
   * elsewhere.
   */
  composer?: ReactNode;
}

const POLL_MS = 1_500;
/** Show ActivityRow only if the latest tool_use is fresher than this. */
const ACTIVITY_FRESH_MS = 60_000;

export function SessionLog({
  sessionId,
  repo,
  role,
  title,
  hideKill,
  onClearConversation,
  composer,
}: Props) {
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
  const [matchIdx, setMatchIdx] = useState(0);
  const [pinnedUserUuid, setPinnedUserUuid] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [showTools, setShowTools] = useState(true);
  const [copied, setCopied] = useState(false);

  const scrollRef = useRef<HTMLDivElement>(null);
  const stickyBottomRef = useRef(true);
  const searchInputRef = useRef<HTMLInputElement>(null);
  // Scroll-restoration handoff: backward fetch sets prevHeight here, the
  // layout effect after re-render restores scrollTop from the bottom edge
  // so prepending older rows doesn't visually jump.
  const pendingScrollRestoreRef = useRef<{
    prevHeight: number;
    prevTop: number;
  } | null>(null);

  // Reset on session change.
  useEffect(() => {
    setEntries([]);
    setOffset(0);
    setHeadOffset(null);
    setError(null);
    setPinnedUserUuid(null);
    setMatchIdx(0);
    pendingScrollRestoreRef.current = null;
    stickyBottomRef.current = true;
  }, [sessionId, repo]);

  // Keep `now` ticking so the ActivityRow heuristic re-evaluates.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

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

  const loadOlder = useCallback(async () => {
    if (!sessionId || !repo || headOffset === null || headOffset <= 0) return;
    if (loading) return;
    setLoading(true);
    const el = scrollRef.current;
    if (el) {
      pendingScrollRestoreRef.current = {
        prevHeight: el.scrollHeight,
        prevTop: el.scrollTop,
      };
    }
    try {
      const data = await api.sessions.tailBefore(
        sessionId,
        repo,
        headOffset,
      );
      if (data.lines && data.lines.length > 0) {
        setEntries((prev) => [...(data.lines as LogEntry[]), ...prev]);
        setHeadOffset(data.beforeOffset);
      } else {
        pendingScrollRestoreRef.current = null;
      }
    } catch (e) {
      pendingScrollRestoreRef.current = null;
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [sessionId, repo, headOffset, loading]);

  // Auto-scroll to bottom on new lines unless user scrolled up. The
  // restore-handoff path takes precedence — it owns scrollTop while
  // it's set.
  useEffect(() => {
    if (pendingScrollRestoreRef.current) return;
    if (!stickyBottomRef.current) return;
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [entries.length]);

  // Restore scroll position after a backward-load prepend: capture height
  // delta and pin the offset from the bottom so the user's view doesn't
  // jump. Runs synchronously before paint.
  useLayoutEffect(() => {
    const restore = pendingScrollRestoreRef.current;
    if (!restore) return;
    const el = scrollRef.current;
    if (!el) {
      pendingScrollRestoreRef.current = null;
      return;
    }
    el.scrollTop = el.scrollHeight - restore.prevHeight + restore.prevTop;
    pendingScrollRestoreRef.current = null;
  }, [entries]);

  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
    stickyBottomRef.current = nearBottom;
    // Backward-load trigger: at the very top, with older history left.
    if (
      el.scrollTop < 32 &&
      headOffset !== null &&
      headOffset > 0 &&
      !loading
    ) {
      void loadOlder();
    }
  }, [headOffset, loading, loadOlder]);

  // -- Pinned-user observer ----------------------------------------------

  const recomputePinnedUuid = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (stickyBottomRef.current) {
      setPinnedUserUuid(null);
      return;
    }
    const containerTop = el.getBoundingClientRect().top;
    const threshold = containerTop + 4;
    const rows = el.querySelectorAll<HTMLDivElement>("[data-user-uuid]");
    let pickUuid: string | null = null;
    for (const row of rows) {
      const r = row.getBoundingClientRect();
      if (r.bottom <= threshold) {
        const uuid = row.getAttribute("data-user-uuid") || "";
        if (uuid) pickUuid = uuid;
      } else {
        break;
      }
    }
    setPinnedUserUuid((prev) => (prev === pickUuid ? prev : pickUuid));
  }, []);

  const rafScheduledRef = useRef(false);
  const schedulePinnedRecalc = useCallback(() => {
    if (rafScheduledRef.current) return;
    rafScheduledRef.current = true;
    requestAnimationFrame(() => {
      rafScheduledRef.current = false;
      recomputePinnedUuid();
    });
  }, [recomputePinnedUuid]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const rows = el.querySelectorAll<HTMLDivElement>("[data-user-uuid]");
    if (rows.length === 0) {
      setPinnedUserUuid(null);
      return;
    }
    const io = new IntersectionObserver(
      () => schedulePinnedRecalc(),
      { root: el, threshold: [0, 1] },
    );
    rows.forEach((r) => io.observe(r));
    schedulePinnedRecalc();
    return () => io.disconnect();
  }, [entries, schedulePinnedRecalc]);

  // -- Memo/derived state ------------------------------------------------

  const lastUserUuid = useMemo(() => {
    for (let i = entries.length - 1; i >= 0; i--) {
      if (classify(entries[i]) === "user" && entries[i].uuid)
        return entries[i].uuid as string;
    }
    return null;
  }, [entries]);

  // Pull a human-readable title from any `ai-title` entry Claude wrote.
  const sessionTitle = useMemo(() => {
    for (let i = entries.length - 1; i >= 0; i--) {
      const e = entries[i];
      if (e.type !== "ai-title") continue;
      const title = e.aiTitle ?? (e as { title?: unknown }).title;
      if (typeof title === "string" && title.trim()) return title.trim();
    }
    return null;
  }, [entries]);

  const trimmed = entries.length > MAX_RENDERED
    ? entries.length - MAX_RENDERED
    : 0;
  const visibleEntries = useMemo(() => {
    const cut =
      entries.length > MAX_RENDERED
        ? entries.slice(entries.length - MAX_RENDERED)
        : entries;
    if (showTools) return cut;
    // When tools are hidden, drop tool_result rows AND any user entries
    // whose content is exclusively tool results (LogRow already classifies
    // these — but we filter at this layer so the activity row + counts
    // line up with what's visible).
    return cut.filter((e) => {
      const k = classify(e);
      return k !== "tool_result";
    });
  }, [entries, showTools]);

  // Pre-build lowercase index so per-keystroke filtering doesn't restringify.
  const searchIndex = useMemo(
    () =>
      visibleEntries.map((e, i) => {
        const c = e.message?.content;
        const text = typeof c === "string" ? c : JSON.stringify(c ?? "");
        return { idx: i, text: text.toLowerCase() };
      }),
    [visibleEntries],
  );

  const matchedIndices = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return [] as number[];
    const out: number[] = [];
    for (const item of searchIndex) {
      if (item.text.includes(q)) out.push(item.idx);
    }
    return out;
  }, [search, searchIndex]);

  // Reset the cursor whenever the result-set changes underneath us.
  useEffect(() => {
    setMatchIdx(0);
  }, [search]);

  // Scroll matched row into view. Use a stable data attribute we attach
  // to each row wrapper.
  useEffect(() => {
    if (!showSearch || matchedIndices.length === 0) return;
    const el = scrollRef.current;
    if (!el) return;
    const targetIdx = matchedIndices[matchIdx % matchedIndices.length];
    const row = el.querySelector<HTMLElement>(
      `[data-row-idx="${targetIdx}"]`,
    );
    if (!row) return;
    row.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [matchIdx, matchedIndices, showSearch]);

  // Cmd/Ctrl+F intercept when the SessionLog body is in viewport.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === "f") {
        const el = scrollRef.current;
        if (!el) return;
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) return;
        e.preventDefault();
        setShowSearch(true);
        setTimeout(() => searchInputRef.current?.focus(), 0);
      }
      if (e.key === "Escape" && showSearch) {
        setShowSearch(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [showSearch]);

  // Sum per-turn `message.usage` across loaded entries (running total).
  const sessionTotals = useMemo<TokenTotals>(() => {
    const t: TokenTotals = {
      input: 0,
      output: 0,
      cacheCreate: 0,
      cacheRead: 0,
      turns: 0,
    };
    for (const e of entries) {
      if (e.type !== "assistant") continue;
      const u = e.message?.usage;
      if (!u) continue;
      t.input += typeof u.input_tokens === "number" ? u.input_tokens : 0;
      t.output += typeof u.output_tokens === "number" ? u.output_tokens : 0;
      t.cacheCreate! +=
        typeof u.cache_creation_input_tokens === "number"
          ? u.cache_creation_input_tokens
          : 0;
      t.cacheRead! +=
        typeof u.cache_read_input_tokens === "number"
          ? u.cache_read_input_tokens
          : 0;
      t.turns! += 1;
    }
    return t;
  }, [entries]);

  // -- Activity heuristic (no SSE yet) -----------------------------------
  //
  // Without a "status" stream, infer a thinking/running indicator from
  // the tail of the .jsonl: if the last assistant entry ends with a
  // tool_use that has no matching tool_result yet AND it landed within
  // the last 60s, show "Running: <tool>". Else idle.
  const activity: { kind: "thinking" | "running" | "idle"; label?: string } =
    useMemo(() => {
      // when SSE 'status' events land, drive directly from event.tool
      // — for now this purely reads the .jsonl tail.
      let pendingToolUseName: string | null = null;
      let pendingToolUseId: string | null = null;
      let pendingTs = 0;
      for (let i = entries.length - 1; i >= 0; i--) {
        const e = entries[i];
        if (e.type === "assistant") {
          const blocks = asBlocks(e.message?.content);
          for (let j = blocks.length - 1; j >= 0; j--) {
            const b = blocks[j];
            if (b.type === "tool_use") {
              pendingToolUseName = b.name ?? "tool";
              pendingToolUseId = b.id ?? null;
              pendingTs = e.timestamp ? Date.parse(e.timestamp) : 0;
              break;
            }
          }
          break;
        }
      }
      if (!pendingToolUseName) return { kind: "idle" };
      // Walk forward of the pending tool_use to see if a matching result
      // arrived already.
      for (const e of entries) {
        if (e.type !== "user") continue;
        const blocks = asBlocks(e.message?.content);
        for (const b of blocks) {
          if (
            b.type === "tool_result" &&
            (!pendingToolUseId || b.tool_use_id === pendingToolUseId)
          ) {
            return { kind: "idle" };
          }
        }
      }
      const age = pendingTs ? now - pendingTs : Infinity;
      if (!Number.isFinite(age) || age > ACTIVITY_FRESH_MS)
        return { kind: "idle" };
      return { kind: "running", label: `Running: ${pendingToolUseName}` };
    }, [entries, now]);

  // -- Pinned-user text --------------------------------------------------

  const userTextOf = useCallback((e: LogEntry): string => {
    const blocks = asBlocks(e.message?.content);
    const raw = blocks
      .filter((b: ContentBlock) => b.type === "text" && typeof b.text === "string")
      .map((b: ContentBlock) => b.text!)
      .join(" ");
    const { stripped } = extractAttachments(raw);
    const cleaned = stripSystemTags(stripped);
    return cleaned.trim() || stripped.trim() || raw.trim();
  }, []);

  const pinnedUserText = useMemo(() => {
    if (!pinnedUserUuid) return null;
    for (const e of visibleEntries) {
      if (e.uuid !== pinnedUserUuid) continue;
      if (classify(e) !== "user") continue;
      return userTextOf(e);
    }
    return null;
  }, [pinnedUserUuid, visibleEntries, userTextOf]);

  // -- Toolbar handlers --------------------------------------------------

  const copySessionId = useCallback(async () => {
    if (!sessionId) return;
    try {
      await navigator.clipboard.writeText(sessionId);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      toast.error("copy failed");
    }
  }, [sessionId, toast]);

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
      <div className="flex h-full items-center justify-center px-6 py-12 font-mono text-micro uppercase tracking-wideish text-fg-dim">
        select a session to view its transcript.
      </div>
    );
  }

  // Stable key per main:
  //   uuid → message.id → "<timestamp>:<type>" → "pos-<trimmed+i>"
  const entryKey = (e: LogEntry, i: number): string =>
    e.uuid ||
    e.message?.id ||
    (e.timestamp ? `${e.timestamp}:${e.type ?? ""}` : `pos-${trimmed + i}`);

  // Header chrome — main's tight one-line layout: terminal icon + role +
  // "@ repo" + italic ai-title + responding pulse pill. No "session"
  // eyebrow; no uppercase role badge.
  return (
    <section className="flex-1 min-w-0 min-h-0 flex flex-col bg-card relative overflow-hidden">
      {showSearch && (
        <div className="absolute top-2 right-3 z-30 flex items-center gap-1 rounded-md border border-border bg-card shadow-lg px-2 py-1.5 text-xs">
          <Search size={12} className="text-fg-dim shrink-0" />
          <input
            ref={searchInputRef}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                if (matchedIndices.length === 0) return;
                setMatchIdx((i) =>
                  e.shiftKey
                    ? (i - 1 + matchedIndices.length) % matchedIndices.length
                    : (i + 1) % matchedIndices.length,
                );
              } else if (e.key === "Escape") {
                setShowSearch(false);
              }
            }}
            placeholder="Search conversation"
            className="bg-transparent border-0 outline-none text-xs w-44 placeholder:text-fg-dim"
            aria-label="Search conversation"
          />
          <span className="text-[10px] text-fg-dim tabular-nums shrink-0 min-w-[44px] text-right">
            {search
              ? matchedIndices.length === 0
                ? "no matches"
                : `${matchIdx + 1}/${matchedIndices.length}`
              : ""}
          </span>
          <button
            type="button"
            onClick={() =>
              matchedIndices.length &&
              setMatchIdx((i) => (i - 1 + matchedIndices.length) % matchedIndices.length)
            }
            disabled={matchedIndices.length === 0}
            className="p-1 rounded text-fg-dim hover:text-foreground disabled:opacity-40"
            title="Previous match (Shift+Enter)"
            aria-label="Previous match"
          >
            <ArrowUp size={12} />
          </button>
          <button
            type="button"
            onClick={() =>
              matchedIndices.length &&
              setMatchIdx((i) => (i + 1) % matchedIndices.length)
            }
            disabled={matchedIndices.length === 0}
            className="p-1 rounded text-fg-dim hover:text-foreground disabled:opacity-40"
            title="Next match (Enter)"
            aria-label="Next match"
          >
            <ArrowDown size={12} />
          </button>
          <button
            type="button"
            onClick={() => setShowSearch(false)}
            className="p-1 rounded text-fg-dim hover:text-foreground"
            title="Close (Esc)"
            aria-label="Close search"
          >
            <X size={12} />
          </button>
        </div>
      )}

      <header className="px-3 py-2 border-b border-border flex items-center gap-2 text-xs min-w-0">
        <Terminal size={13} className="text-muted-foreground shrink-0" />
        {role && (
          <span className="font-medium whitespace-nowrap shrink-0">{role}</span>
        )}
        {repo && (
          <span className="text-muted-foreground whitespace-nowrap shrink-0">
            @ {repo}
          </span>
        )}
        {sessionTitle && (
          <span
            className="text-muted-foreground italic truncate min-w-0"
            title={sessionTitle}
          >
            · {sessionTitle}
          </span>
        )}
        {!sessionTitle && title && (
          <span className="text-muted-foreground italic truncate min-w-0" title={title}>
            · {title}
          </span>
        )}
        {activity.kind !== "idle" && (
          <span className="inline-flex items-center gap-1 text-warning text-[10.5px] whitespace-nowrap shrink-0">
            <span className="relative inline-flex h-1.5 w-1.5">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-warning opacity-60" />
              <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-warning" />
            </span>
            responding…
          </span>
        )}
        <div className="ml-auto flex items-center gap-1 shrink-0">
          {(sessionTotals.turns ?? 0) > 0 && (
            <TokenUsage
              totals={sessionTotals}
              variant="compact"
              title={`This window: ${sessionTotals.turns} assistant turns · in ${sessionTotals.input.toLocaleString()} · out ${sessionTotals.output.toLocaleString()} · cache read ${(sessionTotals.cacheRead ?? 0).toLocaleString()}`}
            />
          )}
          <button
            onClick={() => {
              setShowSearch(true);
              setTimeout(() => searchInputRef.current?.focus(), 0);
            }}
            className="inline-flex items-center gap-1 h-7 w-7 md:w-auto md:px-1.5 md:h-6 justify-center rounded-md border border-border text-muted-foreground hover:text-foreground hover:bg-accent text-[10px] transition-colors"
            title="Search this conversation (Ctrl/⌘+F)"
            aria-label="Search conversation"
          >
            <Search size={11} />
            <span className="hidden md:inline">Search</span>
          </button>
          <button
            onClick={() => setShowTools((v) => !v)}
            className={cn(
              "hidden md:inline-flex items-center gap-1 px-1.5 h-6 rounded-md border text-[10px] transition-colors",
              showTools
                ? "border-border bg-secondary text-foreground"
                : "border-border text-muted-foreground hover:text-foreground hover:bg-accent",
            )}
            title="Toggle tool results"
          >
            <Wrench size={10} /> {showTools ? "tools" : "no tools"}
          </button>
          <button
            onClick={handleDownload}
            className="hidden md:inline-flex items-center gap-1 px-1.5 h-6 rounded-md border border-border text-muted-foreground hover:text-foreground hover:bg-accent text-[10px]"
            title="Export this conversation as Markdown"
          >
            <Download size={10} /> Export
          </button>
          <button
            onClick={() => void copySessionId()}
            className="hidden md:inline-flex items-center gap-1 text-muted-foreground hover:text-foreground font-mono text-[11px]"
            title="Copy session ID"
          >
            {sessionId.slice(0, 8)}…
            {copied ? (
              <Check size={11} className="text-success" />
            ) : (
              <Copy size={11} />
            )}
          </button>
          {onClearConversation && (
            <button
              onClick={onClearConversation}
              className="hidden md:inline-flex items-center gap-1 px-1.5 h-6 rounded-md border border-border text-muted-foreground hover:text-foreground hover:bg-accent text-[10px]"
              title="Spawn a fresh coordinator"
            >
              <RotateCw size={10} /> Clear
            </button>
          )}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                className="md:hidden inline-flex items-center justify-center h-7 w-7 rounded-md border border-border text-muted-foreground hover:text-foreground hover:bg-accent"
                title="More actions"
                aria-label="More actions"
              >
                <MoreVertical size={14} />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-52">
              <DropdownMenuItem onClick={() => setShowTools((v) => !v)}>
                <Wrench size={12} />
                {showTools ? "Hide tool results" : "Show tool results"}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={handleDownload}>
                <Download size={12} />
                Export Markdown
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => void copySessionId()}>
                {copied ? (
                  <Check size={12} className="text-success" />
                ) : (
                  <Copy size={12} />
                )}
                <span className="font-mono">{sessionId.slice(0, 8)}…</span>
              </DropdownMenuItem>
              {onClearConversation && (
                <DropdownMenuItem onClick={onClearConversation}>
                  <RotateCw size={12} />
                  Clear conversation
                </DropdownMenuItem>
              )}
              {!hideKill && (
                <DropdownMenuItem onClick={() => void handleKill()}>
                  <X size={12} />
                  Kill session
                </DropdownMenuItem>
              )}
              <DropdownMenuItem
                onClick={() => void handleRewind()}
                disabled={!lastUserUuid}
              >
                <ArrowUp size={12} />
                Rewind
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </header>

      {error && (
        <div className="shrink-0 border-b border-border bg-status-blocked/10 px-4 py-2 font-mono text-micro text-status-blocked">
          {error}
        </div>
      )}

      <div className="relative flex-1 min-h-0 min-w-0 flex flex-col">
        <div
          ref={scrollRef}
          onScroll={onScroll}
          className="flex-1 overflow-y-auto overflow-x-hidden font-sans text-xs leading-relaxed"
        >
          {pinnedUserText && (
            <div className="sticky top-0 z-10 backdrop-blur supports-[backdrop-filter]:bg-card/85 border-b border-border px-3 py-1.5">
              <p className="text-[11.5px] text-foreground line-clamp-2 break-words">
                {pinnedUserText}
              </p>
            </div>
          )}
          {trimmed > 0 && (
            <p className="px-4 py-1 text-center text-[11px] italic text-muted-foreground">
              … {trimmed} earlier entries trimmed
            </p>
          )}
          {headOffset !== null && headOffset > 0 && (
            <div className="flex justify-center px-4 py-2">
              <button
                type="button"
                onClick={() => void loadOlder()}
                disabled={loading}
                className="rounded-sm border border-border bg-card px-3 py-1 font-mono text-micro uppercase tracking-wideish text-muted-foreground hover:border-primary/40 hover:text-primary disabled:opacity-50"
              >
                {loading ? "loading…" : "load earlier"}
              </button>
            </div>
          )}
          {entries.length === 0 ? (
            <div className="flex h-full items-center justify-center font-mono text-micro uppercase tracking-wideish text-fg-dim">
              no messages yet — type below to start the conversation.
            </div>
          ) : (
            <div className="py-2 px-1">
              {visibleEntries.map((e, i) => (
                <div key={entryKey(e, i)} data-row-idx={i}>
                  <LogRow
                    entry={e}
                    sessionId={sessionId}
                    repo={repo}
                    onRewind={(uuid) => void handleRewind(uuid)}
                    searchQuery={search}
                  />
                </div>
              ))}
            </div>
          )}
        </div>

        {!stickyBottomRef.current && entries.length > 0 && (
          <button
            onClick={() => {
              stickyBottomRef.current = true;
              const el = scrollRef.current;
              if (el) el.scrollTop = el.scrollHeight;
            }}
            className="absolute bottom-3 right-4 z-20 inline-flex items-center gap-1 px-2.5 py-1 rounded-full bg-primary text-primary-foreground text-[11px] font-medium shadow-lg hover:bg-primary/90"
          >
            <ArrowDown size={11} /> Jump to latest
          </button>
        )}
      </div>

      <ActivityRow activity={activity} />

      <InlinePermissionRequests sessionId={sessionId} />

      {composer && (
        <div className="sticky bottom-0 z-20 border-t border-border bg-card">
          {composer}
        </div>
      )}
    </section>
  );
}

// Re-exported for callers that want to pre-classify a list.
export type { LogEntry, SessionMessage };
