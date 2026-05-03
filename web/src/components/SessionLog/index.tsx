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
} from "react";
import {
  ArrowDown,
  ArrowUp,
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
  const visibleEntries = useMemo(
    () =>
      entries.length > MAX_RENDERED
        ? entries.slice(entries.length - MAX_RENDERED)
        : entries,
    [entries],
  );

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

  const scrollToPinned = useCallback(() => {
    if (!pinnedUserUuid) return;
    const el = scrollRef.current;
    if (!el) return;
    const row = el.querySelector<HTMLElement>(
      `[data-user-uuid="${CSS.escape(pinnedUserUuid)}"]`,
    );
    if (row) row.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [pinnedUserUuid]);

  // -- Toolbar handlers --------------------------------------------------

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

  const headerTitle = sessionTitle ?? title ?? sessionId.slice(0, 8);

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Header */}
      <header className="flex shrink-0 items-center gap-3 border-b border-border bg-card px-4 py-2">
        <span className="font-mono text-micro uppercase tracking-wideish text-muted-foreground">
          session
        </span>
        <span className="truncate font-mono text-micro text-foreground">
          {headerTitle}
        </span>
        {role && (
          <span className="rounded-sm border border-primary/30 bg-primary/10 px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wideish text-primary">
            {role}
          </span>
        )}
        <span className="ml-auto flex items-center gap-1">
          {(sessionTotals.turns ?? 0) > 0 && (
            <TokenUsage
              totals={sessionTotals}
              variant="compact"
              title={`This window: ${sessionTotals.turns} assistant turns · in ${sessionTotals.input.toLocaleString()} · out ${sessionTotals.output.toLocaleString()} · cache read ${(sessionTotals.cacheRead ?? 0).toLocaleString()}`}
            />
          )}
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
        <div className="shrink-0 border-b border-border bg-secondary px-4 py-2">
          <div className="flex items-center gap-2">
            <div className="relative flex-1">
              <Search
                size={12}
                className="absolute left-2 top-1/2 -translate-y-1/2 text-fg-dim"
              />
              <input
                autoFocus
                ref={searchInputRef}
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    if (matchedIndices.length === 0) return;
                    setMatchIdx((i) =>
                      e.shiftKey
                        ? (i - 1 + matchedIndices.length) %
                          matchedIndices.length
                        : (i + 1) % matchedIndices.length,
                    );
                  } else if (e.key === "Escape") {
                    setShowSearch(false);
                  }
                }}
                placeholder="search transcript… (enter for next, shift+enter prev)"
                className="w-full rounded-sm border border-border bg-background pl-7 pr-7 py-1 font-mono text-micro text-foreground focus:border-primary focus:outline-none"
              />
              {search && (
                <button
                  type="button"
                  onClick={() => setSearch("")}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-fg-dim hover:text-foreground"
                  aria-label="clear search"
                >
                  <X size={11} />
                </button>
              )}
            </div>
            {search && (
              <>
                <span className="font-mono text-[10px] tabular-nums text-fg-dim min-w-[44px] text-right">
                  {matchedIndices.length === 0
                    ? "0/0"
                    : `${matchIdx + 1}/${matchedIndices.length}`}
                </span>
                <button
                  type="button"
                  disabled={matchedIndices.length === 0}
                  onClick={() =>
                    setMatchIdx(
                      (i) =>
                        (i - 1 + matchedIndices.length) %
                        matchedIndices.length,
                    )
                  }
                  className="rounded-sm border border-border bg-background p-1 text-fg-dim hover:text-foreground disabled:opacity-40"
                  title="previous (shift+enter)"
                  aria-label="previous match"
                >
                  <ArrowUp size={11} />
                </button>
                <button
                  type="button"
                  disabled={matchedIndices.length === 0}
                  onClick={() =>
                    setMatchIdx((i) => (i + 1) % matchedIndices.length)
                  }
                  className="rounded-sm border border-border bg-background p-1 text-fg-dim hover:text-foreground disabled:opacity-40"
                  title="next (enter)"
                  aria-label="next match"
                >
                  <ArrowDown size={11} />
                </button>
              </>
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
        {pinnedUserText && (
          <button
            type="button"
            onClick={scrollToPinned}
            className="sticky top-0 z-10 block w-full border-b border-border bg-card/85 px-4 py-1.5 text-left backdrop-blur supports-[backdrop-filter]:bg-card/85 hover:bg-card"
            title="scroll back to this user message"
          >
            <div className="flex items-baseline gap-2">
              <span className="shrink-0 font-mono text-[10px] uppercase tracking-wideish text-primary">
                ↥ user
              </span>
              <span className="line-clamp-2 break-words font-sans text-[11.5px] text-foreground">
                {pinnedUserText}
              </span>
            </div>
          </button>
        )}
        {trimmed > 0 && (
          <p className="px-4 py-1 text-center font-mono text-[11px] italic text-muted-foreground">
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
          <div className="py-2">
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
          type="button"
          onClick={() => {
            stickyBottomRef.current = true;
            const el = scrollRef.current;
            if (el) el.scrollTop = el.scrollHeight;
          }}
          className="absolute bottom-16 right-6 inline-flex items-center gap-1 rounded-full border border-border bg-card px-3 py-1.5 font-mono text-micro uppercase tracking-wideish text-muted-foreground shadow-lg hover:border-primary/40 hover:text-primary"
        >
          <ArrowDown size={11} />
          jump to latest
        </button>
      )}

      <ActivityRow activity={activity} />

      <InlinePermissionRequests sessionId={sessionId} />
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
            ? "border-primary bg-primary/10 text-primary"
            : "border-border text-muted-foreground hover:border-input hover:text-foreground",
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
