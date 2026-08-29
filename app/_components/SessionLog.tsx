"use client";

import { memo, startTransition, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Repo } from "@/libs/client/types";
import { api } from "@/libs/client/api";
import {
  Terminal, ArrowDown, OctagonAlert,
  Undo2, Pencil, RefreshCw,
  Search, X, ArrowUp,
} from "lucide-react";
import type { TokenTotals } from "./TokenUsage";
import { useToast } from "./Toasts";
import { useConfirm } from "./ConfirmProvider";
import { MessageComposer } from "./MessageComposer";
import { InlinePermissionRequests } from "./InlinePermissionRequests";

import {
  asBlocks,
  classify,
  entryPlainText,
  extractAttachments,
  formatEntryTime,
  stripSystemTags,
  type ActiveRun,
  type ContentBlock,
  type LogEntry,
} from "./SessionLog/helpers";
import { CopyButton } from "./ui/copy-button";
import { FileRefRepoProvider } from "./SessionLog/FileRefLink";
import {
  ActivityRow,
  AttachmentChip,
  InlineImage,
  TextBlockView,
  ThinkingBlockView,
  ToolResultView,
  ToolUseView,
} from "./SessionLog/views";
import { EmptyOrStreaming, StreamingPartialsList } from "./SessionLog/StreamingRows";
import { useChatSearch } from "./SessionLog/useChatSearch";
import { useScrollManager } from "./SessionLog/useScrollManager";
import { useSessionStream } from "./SessionLog/useSessionStream";
import { SessionLogHeader } from "./SessionLog/SessionLogHeader";


const LogRow = memo(function LogRow({
  entry,
  sessionId,
  onRewindToHere,
  onEditHere,
  onRegenerate,
  toolNames,
  repo,
  prevTimestamp,
  canAnswer,
  onAnswer,
}: {
  entry: LogEntry;
  sessionId: string;
  onRewindToHere?: (uuid: string) => void;
  onEditHere?: (uuid: string, text: string) => void;
  onRegenerate?: () => void;
  toolNames?: Map<string, string>;
  repo?: string;
  prevTimestamp?: string;
  canAnswer?: boolean;
  onAnswer?: (text: string) => void | Promise<void>;
}) {
  const kind = classify(entry);
  if (kind === "hidden") return null;
  const blocks = asBlocks(entry.message?.content);
  const canRewind = kind === "user" && !!entry.uuid && !!onRewindToHere;
  const canEdit = kind === "user" && !!entry.uuid && !!onEditHere;

  if (kind === "user") {
    const textParts: string[] = [];
    const inlineImages: Array<{ mediaType: string; data: string }> = [];
    for (const b of blocks) {
      if (b.type === "text" && typeof b.text === "string") {
        textParts.push(b.text);
      } else if (
        b.type === "image" &&
        b.source?.type === "base64" &&
        typeof b.source.data === "string" &&
        typeof b.source.media_type === "string"
      ) {
        inlineImages.push({ mediaType: b.source.media_type, data: b.source.data });
      }
    }
    const raw = textParts.join("\n\n");
    const { stripped, items: attachments } = extractAttachments(raw);
    const cleaned = stripSystemTags(stripped);
    if (!cleaned.trim() && attachments.length === 0 && inlineImages.length === 0) return null;
    const rowTime = formatEntryTime(entry.timestamp);
    return (
      <div className="group flex justify-end gap-1.5 my-3" data-user-uuid={entry.uuid ?? ""}>
        <div className="self-end flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
          {rowTime && (
            <time
              dateTime={entry.timestamp}
              className="px-1 text-[10px] text-muted-foreground/60 tabular-nums"
            >
              {rowTime}
            </time>
          )}
          {cleaned.trim() && <CopyButton value={cleaned} label="Copy message" size={10} />}
          {canEdit && (
            <button
              onClick={() => onEditHere!(entry.uuid!, cleaned)}
              className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] text-muted-foreground/70 hover:text-foreground hover:bg-secondary"
              title="Edit: drop this turn and everything after it, then reopen it in the composer"
            >
              <Pencil size={10} /> edit
            </button>
          )}
          {canRewind && (
            <button
              onClick={() => onRewindToHere!(entry.uuid!)}
              className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] text-muted-foreground/70 hover:text-warning"
              title="Rewind: drop every later entry"
            >
              <Undo2 size={10} /> rewind
            </button>
          )}
        </div>
        <div className="max-w-[80%] flex flex-col items-end gap-1.5">
          {inlineImages.length > 0 && (
            <div className="flex flex-col items-end gap-1.5 max-w-full">
              {inlineImages.map((img, i) => (
                <InlineImage key={`img-${i}`} src={img} />
              ))}
            </div>
          )}
          {attachments.length > 0 && (
            <div className="flex flex-col items-end gap-1.5">
              {attachments.map((a, i) => (
                <AttachmentChip key={i} att={a} sessionId={sessionId} />
              ))}
            </div>
          )}
          {cleaned.trim() && (
            <div className="rounded-2xl rounded-br-md bg-secondary px-3 py-2 text-[12.5px] whitespace-pre-wrap wrap-break-word">
              {cleaned}
            </div>
          )}
        </div>
      </div>
    );
  }

  if (kind === "tool_result") {
    const rendered = blocks
      .map((b, i) => {
        if (b.type !== "tool_result") return null;
        const tuid = b.tool_use_id ?? "";
        const name = tuid && toolNames ? toolNames.get(tuid) : undefined;
        const suppress = name === "TodoWrite" || name === "AskUserQuestion";
        const key = tuid || `idx-${i}`;
        return <ToolResultView key={key} block={b} suppress={suppress} repo={repo} />;
      })
      .filter(Boolean);
    if (rendered.length === 0) return null;
    return <div className="my-0.5">{rendered}</div>;
  }

  type Renderable =
    | { kind: "text"; text: string }
    | { kind: "thinking"; text: string }
    | { kind: "tool_use"; block: ContentBlock };
  const merged: Renderable[] = [];
  for (const b of blocks) {
    if (b.type === "text" && typeof b.text === "string") {
      const last = merged[merged.length - 1];
      if (last && last.kind === "text") {
        last.text += "\n\n" + b.text;
      } else {
        merged.push({ kind: "text", text: b.text });
      }
    } else if (b.type === "thinking" && typeof b.thinking === "string") {
      merged.push({ kind: "thinking", text: b.thinking });
    } else if (b.type === "tool_use") {
      merged.push({ kind: "tool_use", block: b });
    }
  }
  const thoughtDurationSec = (() => {
    if (!prevTimestamp || !entry.timestamp) return undefined;
    const a = Date.parse(prevTimestamp);
    const b = Date.parse(entry.timestamp);
    if (!Number.isFinite(a) || !Number.isFinite(b) || b <= a) return undefined;
    return (b - a) / 1000;
  })();
  const stopReason = entry.message?.stop_reason;
  const showStopBadge =
    typeof stopReason === "string" &&
    stopReason !== "end_turn" &&
    stopReason !== "tool_use";
  const replyText = entryPlainText(entry);
  const rowTime = formatEntryTime(entry.timestamp);
  const showActions = !!replyText || !!onRegenerate;
  return (
    <div className="group my-2 space-y-1">
      {merged.map((m, i) => {
        if (m.kind === "text") return <TextBlockView key={i} text={m.text} role="assistant" />;
        if (m.kind === "thinking") return <ThinkingBlockView key={i} text={m.text} durationSec={thoughtDurationSec} />;
        return <ToolUseView key={i} block={m.block} canAnswer={canAnswer} onAnswer={onAnswer} />;
      })}
      {showActions && (
        <div className="flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
          {rowTime && (
            <time
              dateTime={entry.timestamp}
              className="px-1 text-[10px] text-muted-foreground/60 tabular-nums"
            >
              {rowTime}
            </time>
          )}
          {replyText && <CopyButton value={replyText} label="Copy response" size={10} />}
          {onRegenerate && (
            <button
              onClick={onRegenerate}
              className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] text-muted-foreground/70 hover:text-foreground hover:bg-secondary"
              title="Regenerate: drop this turn and send the previous message again"
            >
              <RefreshCw size={10} /> retry
            </button>
          )}
        </div>
      )}
      {showStopBadge && (
        <div className="mt-1.5 inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] bg-warning/10 text-warning border border-warning/30">
          <OctagonAlert size={10} />
          stopped: {stopReason}
        </div>
      )}
    </div>
  );
}, (prev, next) => {
  if (prev.entry !== next.entry) return false;
  if (prev.sessionId !== next.sessionId) return false;
  if (prev.onRewindToHere !== next.onRewindToHere) return false;
  if (prev.repo !== next.repo) return false;
  if (prev.prevTimestamp !== next.prevTimestamp) return false;
  if (prev.canAnswer !== next.canAnswer) return false;
  if (prev.onAnswer !== next.onAnswer) return false;
  if (classify(next.entry) === "tool_result") {
    const blocks = asBlocks(next.entry.message?.content);
    for (const b of blocks) {
      if (b.type === "tool_result" && typeof b.tool_use_id === "string") {
        const a = prev.toolNames?.get(b.tool_use_id);
        const c = next.toolNames?.get(b.tool_use_id);
        if (a !== c) return false;
      }
    }
  }
  return true;
});

function SessionLogInner({
  run,
  repos,
  taskId,
  onClearConversation,
}: {
  run: ActiveRun | null;
  repos: Repo[];
  taskId?: string;
  onClearConversation?: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const [showTools, setShowTools] = useState(true);
  // nonce lets the same text be pushed into the composer twice in a row.
  const [composerPrefill, setComposerPrefill] = useState<{ text: string; nonce: number } | null>(null);
  const offsetRef = useRef(0);
  const firstOffsetRef = useRef<number | null>(null);
  const entryOffsetsRef = useRef<number[]>([]);
  const loadedOlderCountRef = useRef(0);
  const inFlightOlderRef = useRef(false);
  const pendingScrollRestoreRef = useRef<{ prevHeight: number; prevTop: number } | null>(null);
  const logRef = useRef<HTMLDivElement>(null);
  const toast = useToast();
  const confirm = useConfirm();

  const onRewindFromPalette = useCallback(() => {
    toast(
      "info",
      "Rewind only from the log: tap rewind beside the user message you want to roll back to.",
    );
  }, [toast]);

  const {
    entries,
    setEntries,
    trimmed,
    setTrimmed,
    activity,
    aliveSse,
    lastTs,
    loadOlder,
    loadingOlder,
  } = useSessionStream(
    run,
    logRef,
    offsetRef,
    firstOffsetRef,
    entryOffsetsRef,
    loadedOlderCountRef,
    inFlightOlderRef,
    pendingScrollRestoreRef,
  );

  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (aliveSse !== null) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [aliveSse]);
  const isResponding = aliveSse ?? (lastTs > 0 && now - lastTs < 4000);

  const visibleEntries = useMemo(
    () =>
      entries.filter((e) => {
        const k = classify(e);
        if (k === "hidden") return false;
        if (!showTools && k === "tool_result") return false;
        return true;
      }),
    [entries, showTools],
  );

  const {
    searchOpen,
    searchQuery,
    matchIdx,
    matchedKeys,
    setSearchQuery,
    searchInputRef,
    open: openSearch,
    next: nextMatch,
    prev: prevMatch,
    close: closeSearch,
  } = useChatSearch(visibleEntries, logRef);

  const sessionTotals = useMemo<TokenTotals>(() => {
    const t = {
      inputTokens: 0, outputTokens: 0,
      cacheCreationTokens: 0, cacheReadTokens: 0, turns: 0,
    };
    for (const e of entries) {
      if (e.type !== "assistant") continue;
      const u = e.message?.usage;
      if (!u) continue;
      t.inputTokens         += typeof u.input_tokens === "number" ? u.input_tokens : 0;
      t.outputTokens        += typeof u.output_tokens === "number" ? u.output_tokens : 0;
      t.cacheCreationTokens += typeof u.cache_creation_input_tokens === "number" ? u.cache_creation_input_tokens : 0;
      t.cacheReadTokens     += typeof u.cache_read_input_tokens === "number" ? u.cache_read_input_tokens : 0;
      t.turns += 1;
    }
    return t;
  }, [entries]);

  const sessionTitle = useMemo(
    () => entries
      .findLast(
        (e) => e.type === "ai-title" && typeof e.aiTitle === "string" && e.aiTitle.trim().length > 0,
      )
      ?.aiTitle?.trim() ?? null,
    [entries],
  );

  const toolNames = useMemo(() => {
    const m = new Map<string, string>();
    for (const e of entries) {
      if (e.type !== "assistant") continue;
      const blocks = asBlocks(e.message?.content);
      for (const b of blocks) {
        if (b.type === "tool_use" && typeof b.id === "string" && typeof b.name === "string") {
          m.set(b.id, b.name);
        }
      }
    }
    return m;
  }, [entries]);

  const {
    autoScroll,
    setAutoScroll,
    scrollToBottom,
    setPinnedUserUuid,
    pinnedUserText,
    handleScroll,
  } = useScrollManager(
    entries,
    visibleEntries,
    logRef,
    pendingScrollRestoreRef,
    firstOffsetRef,
    inFlightOlderRef,
    loadOlder,
  );

  const copySessionId = useCallback(async () => {
    if (!run) return;
    try {
      await navigator.clipboard.writeText(run.sessionId);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { toast("error", "Clipboard blocked"); }
  }, [run, toast]);

  const onSent = useCallback(
    (text: string) => {
      setAutoScroll(true);
      const trimmed = text.trim();
      if (!trimmed) return;
      const synthetic: LogEntry = {
        type: "user",
        uuid: `optimistic:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`,
        timestamp: new Date().toISOString(),
        message: { role: "user", content: trimmed },
      };
      startTransition(() => {
        setEntries((prev) => [...prev, synthetic]);
      });
    },
    [setAutoScroll, setEntries],
  );

  const pendingQuestionIdx = useMemo(() => {
    for (let i = visibleEntries.length - 1; i >= 0; i--) {
      const e = visibleEntries[i];
      if (classify(e) === "user") return -1;
      if (
        e.type === "assistant" &&
        asBlocks(e.message?.content).some(
          (b) => b.type === "tool_use" && b.name === "AskUserQuestion",
        )
      ) {
        return i;
      }
    }
    return -1;
  }, [visibleEntries]);

  // Last real user turn — the anchor both regenerate and edit truncate back to.
  // Optimistic rows have no server-side uuid, so they cannot be truncated to.
  // Kept as two primitives rather than an object so the memo stays stable.
  const lastUserIdx = useMemo(() => {
    for (let i = visibleEntries.length - 1; i >= 0; i--) {
      const e = visibleEntries[i];
      if (classify(e) !== "user") continue;
      if (!e.uuid || e.uuid.startsWith("optimistic:")) return -1;
      return i;
    }
    return -1;
  }, [visibleEntries]);
  const lastUserUuid = lastUserIdx >= 0 ? (visibleEntries[lastUserIdx].uuid ?? null) : null;
  const lastUserText = lastUserIdx >= 0 ? entryPlainText(visibleEntries[lastUserIdx]) : "";

  const lastAssistantIdx = useMemo(() => {
    for (let i = visibleEntries.length - 1; i >= 0; i--) {
      const k = classify(visibleEntries[i]);
      if (k === "user") return -1;
      if (k === "assistant") return i;
    }
    return -1;
  }, [visibleEntries]);

  const handleAnswer = useCallback(
    async (text: string) => {
      if (!run) return;
      const trimmed = text.trim();
      if (!trimmed) return;
      onSent(trimmed);
      try {
        await api.sendMessage(run.sessionId, { message: trimmed, repo: run.repo });
      } catch (e) {
        toast("error", (e as Error).message);
      }
    },
    [run, onSent, toast],
  );

  // The transcript file just changed underneath us, so every paging cursor and
  // cached offset is stale — drop them and let the stream refill from scratch.
  const resetAfterTruncate = useCallback(() => {
    offsetRef.current = 0;
    firstOffsetRef.current = null;
    entryOffsetsRef.current = [];
    loadedOlderCountRef.current = 0;
    inFlightOlderRef.current = false;
    pendingScrollRestoreRef.current = null;
    setEntries([]);
    setTrimmed(0);
    setPinnedUserUuid(null);
  }, [setEntries, setTrimmed, setPinnedUserUuid]);

  const handleRewind = useCallback(async (uuid: string) => {
    if (!run) return;
    const ok = await confirm({
      title: "Rewind to this message?",
      description: "Every later turn in this session will be dropped (the file is truncated). The active claude process, if any, may need to be restarted.",
      confirmLabel: "Rewind",
      destructive: true,
    });
    if (!ok) return;
    try {
      const r = await api.rewind(run.sessionId, { repo: run.repo, uuid });
      toast("success", `Dropped ${r.dropped} entries — kept ${r.kept}`);
      resetAfterTruncate();
    } catch (e) {
      toast("error", (e as Error).message);
    }
  }, [run, toast, confirm, resetAfterTruncate]);

  const handleEdit = useCallback(async (uuid: string, text: string) => {
    if (!run) return;
    const ok = await confirm({
      title: "Edit this message?",
      description:
        "This turn and everything after it are dropped from the transcript, then the text reopens in the composer. The previous version is not kept — Claude Code owns this file and has no notion of branches.",
      confirmLabel: "Edit",
      destructive: true,
    });
    if (!ok) return;
    try {
      const r = await api.rewind(run.sessionId, { repo: run.repo, uuid, inclusive: false });
      toast("info", `Dropped ${r.dropped} entries — edit and send again`);
      resetAfterTruncate();
      setComposerPrefill({ text, nonce: Date.now() });
    } catch (e) {
      toast("error", (e as Error).message);
    }
  }, [run, toast, confirm, resetAfterTruncate]);

  const handleRegenerate = useCallback(async () => {
    if (!run || !lastUserUuid || !lastUserText) return;
    const ok = await confirm({
      title: "Regenerate this response?",
      description:
        "The last turn is dropped and your previous message is sent again unchanged. The old response is not kept.",
      confirmLabel: "Regenerate",
      destructive: true,
    });
    if (!ok) return;
    try {
      await api.rewind(run.sessionId, {
        repo: run.repo,
        uuid: lastUserUuid,
        inclusive: false,
      });
      resetAfterTruncate();
      onSent(lastUserText);
      await api.sendMessage(run.sessionId, {
        message: lastUserText,
        repo: run.repo,
      });
    } catch (e) {
      toast("error", (e as Error).message);
    }
  }, [run, lastUserUuid, lastUserText, toast, confirm, resetAfterTruncate, onSent]);

  const repo = useMemo(() => repos.find((r) => r.path === run?.repoPath), [repos, run?.repoPath]);

  if (!run) {
    return (
      <section className="flex-1 flex items-center justify-center text-fg-dim text-sm bg-card">
        <div className="text-center">
          <Terminal size={32} className="mx-auto mb-2 opacity-30" />
          <p>Select a run to watch its session</p>
        </div>
      </section>
    );
  }

  return (
    <section className="flex-1 min-w-0 min-h-0 flex flex-col bg-card relative overflow-hidden">
      {searchOpen && (
        <div className="absolute top-2 right-3 z-30 flex items-center gap-1 rounded-md border border-border bg-card shadow-lg px-2 py-1.5 text-xs">
          <Search size={12} className="text-fg-dim shrink-0" />
          <input
            ref={searchInputRef}
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                if (matchedKeys.length === 0) return;
                if (e.shiftKey) prevMatch(); else nextMatch();
              } else if (e.key === "Escape") {
                closeSearch();
              }
            }}
            placeholder="Search conversation"
            className="bg-transparent border-0 outline-none text-xs w-44 placeholder:text-fg-dim"
            aria-label="Search conversation"
          />
          <span className="text-[10px] text-fg-dim tabular-nums shrink-0 min-w-[44px] text-right">
            {searchQuery
              ? matchedKeys.length === 0
                ? "no matches"
                : `${matchIdx + 1}/${matchedKeys.length}`
              : ""}
          </span>
          <button
            type="button"
            onClick={() => matchedKeys.length && prevMatch()}
            disabled={matchedKeys.length === 0}
            className="p-1 rounded text-fg-dim hover:text-foreground disabled:opacity-40"
            title="Previous match (Shift+Enter)"
            aria-label="Previous match"
          >
            <ArrowUp size={12} />
          </button>
          <button
            type="button"
            onClick={() => matchedKeys.length && nextMatch()}
            disabled={matchedKeys.length === 0}
            className="p-1 rounded text-fg-dim hover:text-foreground disabled:opacity-40"
            title="Next match (Enter)"
            aria-label="Next match"
          >
            <ArrowDown size={12} />
          </button>
          <button
            type="button"
            onClick={() => closeSearch()}
            className="p-1 rounded text-fg-dim hover:text-foreground"
            title="Close (Esc)"
            aria-label="Close search"
          >
            <X size={12} />
          </button>
        </div>
      )}
      <SessionLogHeader
        run={run}
        repo={repo}
        sessionTitle={sessionTitle}
        isResponding={isResponding}
        sessionTotals={sessionTotals}
        openSearch={openSearch}
        showTools={showTools}
        setShowTools={setShowTools}
        visibleEntries={visibleEntries}
        copied={copied}
        copySessionId={copySessionId}
        onClearConversation={onClearConversation}
      />
      {}
      <div className="relative flex-1 min-h-0 min-w-0 flex flex-col">
        <FileRefRepoProvider repo={run.repo}>
        <div
          ref={logRef}
          onScroll={handleScroll}
          role="log"
          aria-label="Conversation"
          className="flex-1 overflow-y-auto overflow-x-hidden font-sans text-xs leading-relaxed"
        >
        {pinnedUserText && (
          <div className="sticky top-0 z-10 backdrop-blur supports-backdrop-filter:bg-card/85 border-b border-border px-3 py-1.5">
            <p className="text-[11.5px] text-foreground line-clamp-2 wrap-break-word">
              {pinnedUserText}
            </p>
          </div>
        )}
        <div className="p-3">
          {loadingOlder && (
            <p className="text-muted-foreground italic text-[11px] text-center mb-2">
              Loading earlier messages…
            </p>
          )}
          {trimmed > 0 && (
            <p className="text-muted-foreground italic text-[11px] text-center mb-2">
              … {trimmed} earlier entries trimmed
            </p>
          )}
          {visibleEntries.length === 0 ? (
            <EmptyOrStreaming sessionId={run.sessionId} scrollerRef={logRef} autoScroll={autoScroll} />
          ) : (
            <>
              {visibleEntries.map((e, i) => {
                const key =
                  e.uuid ||
                  e.message?.id ||
                  (e.timestamp ? `${e.timestamp}:${e.type ?? ""}` : `pos-${trimmed + i}`);
                const isOptimistic = e.uuid?.startsWith("optimistic:") ?? false;
                return (
                  <div
                    key={key}
                    data-entry-key={key}
                    className={`rounded-md transition-shadow${
                      isOptimistic ? " opacity-60 animate-pulse" : ""
                    }`}
                  >
                    <LogRow
                      entry={e}
                      sessionId={run.sessionId}
                      onRewindToHere={handleRewind}
                      onEditHere={isOptimistic ? undefined : handleEdit}
                      onRegenerate={
                        i === lastAssistantIdx && !isResponding && lastUserUuid
                          ? handleRegenerate
                          : undefined
                      }
                      toolNames={toolNames}
                      repo={run.repo}
                      prevTimestamp={visibleEntries[i - 1]?.timestamp}
                      canAnswer={!isResponding && i === pendingQuestionIdx && !!run.repo}
                      onAnswer={handleAnswer}
                    />
                  </div>
                );
              })}
              {/* Tokens rewrite one node many times a second; letting the log
                  announce that would flood a screen reader, so the status
                  line below carries the state change instead. */}
              <div aria-live="off" aria-busy={isResponding}>
                <StreamingPartialsList sessionId={run.sessionId} scrollerRef={logRef} autoScroll={autoScroll} />
              </div>
            </>
          )}
          {/* Last row of the transcript, not a status bar above the composer —
              it belongs to the conversation and scrolls with it. */}
          <ActivityRow activity={activity} />
        </div>
        </div>
        </FileRefRepoProvider>
        {!autoScroll && visibleEntries.length > 0 && (
          <button
            onClick={scrollToBottom}
            className="absolute bottom-3 right-4 z-20 inline-flex items-center gap-1 px-2.5 py-1 rounded-full bg-primary text-primary-foreground text-[11px] font-medium shadow-lg hover:bg-primary/90 animate-slide-in"
          >
            <ArrowDown size={11} /> Jump to latest
          </button>
        )}
      </div>

      <p role="status" aria-live="polite" className="sr-only">
        {isResponding ? "Assistant is responding" : "Assistant is idle"}
      </p>

      <InlinePermissionRequests sessionId={run.sessionId} />

      <div className="sticky bottom-0 z-20 border-t border-border bg-card">
        <MessageComposer
          sessionId={run.sessionId}
          repo={run.repo}
          repoPath={run.repoPath}
          role={run.role}
          taskId={taskId}
          isResponding={isResponding}
          onSent={onSent}
          onClearConversation={onClearConversation}
          onRewindRequest={onRewindFromPalette}
          prefill={composerPrefill}
        />
      </div>
    </section>
  );
}

const SessionLogMemo = memo(
  SessionLogInner,
  (prev, next) =>
    prev.run?.sessionId === next.run?.sessionId &&
    prev.run?.repoPath === next.run?.repoPath &&
    prev.run?.role === next.run?.role &&
    prev.run?.repo === next.run?.repo &&
    prev.repos === next.repos &&
    prev.taskId === next.taskId &&
    prev.onClearConversation === next.onClearConversation,
);

export function SessionLog(props: {
  run: ActiveRun | null;
  repos: Repo[];
  taskId?: string;
  onClearConversation?: () => void;
}) {
  const k = `${props.run?.sessionId ?? "__none__"}|${props.run?.repoPath ?? ""}`;
  return <SessionLogMemo key={k} {...props} />;
}
