"use client";

import { memo, startTransition, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { Repo } from "@/libs/client/types";
import { api } from "@/libs/client/api";
import {
  Terminal, Copy, Check, ArrowDown, OctagonAlert,
  Undo2, Wrench,
  Search, X, ArrowUp, Download, MoreVertical, RotateCw,
  Loader2,
} from "lucide-react";
import { exportSessionMarkdown, downloadFile } from "@/libs/client/exportTask";
import { TokenUsage, type TokenTotals } from "./TokenUsage";
import { useToast } from "./Toasts";
import { useConfirm } from "./ConfirmProvider";
import { MessageComposer } from "./MessageComposer";
import { InlinePermissionRequests } from "./InlinePermissionRequests";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu";

import {
  asBlocks,
  classify,
  extractAttachments,
  MAX_RENDERED,
  stripSystemTags,
  type ActiveRun,
  type ContentBlock,
  type LogEntry,
} from "./SessionLog/helpers";
import {
  ActivityRow,
  AttachmentChip,
  InlineImage,
  StreamingAssistantRow,
  TextBlockView,
  ThinkingBlockView,
  ToolResultView,
  ToolUseView,
} from "./SessionLog/views";
import {
  appendPartial,
  clearPartials,
  dropOnArrival,
  subscribePartialKeys,
  subscribePartialText,
} from "./SessionLog/partialsStore";


const LogRow = memo(function LogRow({
  entry,
  sessionId,
  onRewindToHere,
  toolNames,
  repo,
  prevTimestamp,
  canAnswer,
  onAnswer,
}: {
  entry: LogEntry;
  sessionId: string;
  onRewindToHere?: (uuid: string) => void;
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
    return (
      <div className="group flex justify-end gap-1.5 my-3" data-user-uuid={entry.uuid ?? ""}>
        {canRewind && (
          <button
            onClick={() => onRewindToHere!(entry.uuid!)}
            className="self-end inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] text-muted-foreground/70 hover:text-warning"
            title="Rewind: drop every later entry"
          >
            <Undo2 size={10} /> rewind
          </button>
        )}
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
  return (
    <div className="my-2 space-y-1">
      {merged.map((m, i) => {
        if (m.kind === "text") return <TextBlockView key={i} text={m.text} role="assistant" />;
        if (m.kind === "thinking") return <ThinkingBlockView key={i} text={m.text} durationSec={thoughtDurationSec} />;
        return <ToolUseView key={i} block={m.block} canAnswer={canAnswer} onAnswer={onAnswer} />;
      })}
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

const StreamingPartialsList = memo(function StreamingPartialsList({
  sessionId,
  scrollerRef,
  autoScroll,
}: {
  sessionId: string;
  scrollerRef: React.RefObject<HTMLDivElement | null>;
  autoScroll: boolean;
}) {
  const sub = useMemo(() => subscribePartialKeys(sessionId), [sessionId]);
  const keys = useSyncExternalStore(sub.subscribe, sub.getSnapshot, sub.getSnapshot);
  if (keys.length === 0) return null;
  return (
    <>
      {keys.map((id) => (
        <StreamingPartialRowConnected
          key={`live-${id}`}
          sessionId={sessionId}
          messageId={id}
          scrollerRef={scrollerRef}
          autoScroll={autoScroll}
        />
      ))}
    </>
  );
});

function StreamingPartialRowConnected({
  sessionId,
  messageId,
  scrollerRef,
  autoScroll,
}: {
  sessionId: string;
  messageId: string;
  scrollerRef: React.RefObject<HTMLDivElement | null>;
  autoScroll: boolean;
}) {
  const sub = useMemo(
    () => subscribePartialText(sessionId, messageId),
    [sessionId, messageId],
  );
  const text = useSyncExternalStore(sub.subscribe, sub.getSnapshot, sub.getSnapshot);
  const autoScrollRef = useRef(autoScroll);
  useEffect(() => { autoScrollRef.current = autoScroll; }, [autoScroll]);
  useEffect(() => {
    if (!autoScrollRef.current) return;
    const el = scrollerRef.current;
    if (!el) return;
    const r = requestAnimationFrame(() => {
      if (autoScrollRef.current && scrollerRef.current) {
        scrollerRef.current.scrollTop = scrollerRef.current.scrollHeight;
      }
    });
    return () => cancelAnimationFrame(r);
  }, [text, scrollerRef]);
  if (!text.trim()) return null;
  return <StreamingAssistantRow text={text} />;
}

function SpawnPlaceholder() {
  const [stalled, setStalled] = useState(false);
  useEffect(() => {
    const h = setTimeout(() => setStalled(true), 30_000);
    return () => clearTimeout(h);
  }, []);
  return (
    <div className="flex items-start gap-2 text-muted-foreground text-[12px]">
      <Loader2 size={14} className="animate-spin shrink-0 mt-0.5 text-primary" />
      <span className="leading-relaxed">
        {stalled
          ? "Still spawning. Check the terminal where you started the bridge for errors."
          : "Spawning coordinator… first response usually arrives in 5-15s."}
      </span>
    </div>
  );
}

function EmptyOrStreaming({
  sessionId,
  scrollerRef,
  autoScroll,
}: {
  sessionId: string;
  scrollerRef: React.RefObject<HTMLDivElement | null>;
  autoScroll: boolean;
}) {
  const sub = useMemo(() => subscribePartialKeys(sessionId), [sessionId]);
  const keys = useSyncExternalStore(sub.subscribe, sub.getSnapshot, sub.getSnapshot);
  if (keys.length === 0) {
    return <SpawnPlaceholder key={sessionId} />;
  }
  return (
    <StreamingPartialsList
      sessionId={sessionId}
      scrollerRef={scrollerRef}
      autoScroll={autoScroll}
    />
  );
}

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
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const [trimmed, setTrimmed] = useState(0);
  const [autoScroll, setAutoScroll] = useState(true);
  const [copied, setCopied] = useState(false);
  const [showTools, setShowTools] = useState(true);
  const [lastTs, setLastTs] = useState<number>(0);
  const [pinnedUserUuid, setPinnedUserUuid] = useState<string | null>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [aliveSse, setAliveSse] = useState<boolean | null>(null);
  const [activity, setActivity] = useState<{
    kind: "thinking" | "running" | "idle";
    label?: string;
  }>({ kind: "idle" });
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

  useEffect(() => {
    if (!run) return;

    let stopped = false;
    let es: EventSource | null = null;
    let aliveSweepTimer: ReturnType<typeof setTimeout> | null = null;

    const applyTail = (payload: {
      lines: unknown[];
      offset: number;
      lineOffsets: number[] | undefined;
    }) => {
      offsetRef.current = payload.offset;
      if (!payload.lines.length) return;
      const lines = payload.lines as LogEntry[];
      const newest = lines[lines.length - 1]?.timestamp;
      if (newest) setLastTs(new Date(newest).getTime());
      const newLineOffsets = Array.isArray(payload.lineOffsets) ? payload.lineOffsets : [];
      const arrivedAssistant = lines.some((l) => l?.type === "assistant");
      if (arrivedAssistant) {
        const arrivedIds: string[] = [];
        for (const l of lines) {
          const id = l?.message?.id;
          if (typeof id === "string") arrivedIds.push(id);
        }
        dropOnArrival(run.sessionId, arrivedIds);
      }
      const arrivedUser = lines.some((l) => l?.type === "user");
      startTransition(() => {
        setEntries((prev) => {
          const baseline = arrivedUser
            ? prev.filter((e) => !(e.uuid && e.uuid.startsWith("optimistic:")))
            : prev;
          const seen = new Set<string>();
          for (const e of baseline) {
            if (e.uuid) seen.add(e.uuid);
          }
          const dedupLines: LogEntry[] = [];
          const dedupOffsets: number[] = [];
          for (let i = 0; i < lines.length; i++) {
            const l = lines[i];
            const id = l?.uuid;
            if (id && seen.has(id)) continue;
            if (id) seen.add(id);
            dedupLines.push(l);
            dedupOffsets.push(newLineOffsets[i] ?? 0);
          }
          if (dedupLines.length === 0 && baseline.length === prev.length) return prev;

          const merged = [...baseline, ...dedupLines];
          const mergedOffsets = [
            ...entryOffsetsRef.current,
            ...dedupOffsets,
          ];
          const protectedFront = loadedOlderCountRef.current;
          const trimWindow = merged.length - protectedFront;
          if (trimWindow <= MAX_RENDERED) {
            entryOffsetsRef.current = mergedOffsets;
            if (firstOffsetRef.current === null) {
              firstOffsetRef.current = mergedOffsets[0] ?? 0;
            }
            return merged;
          }
          const drop = trimWindow - MAX_RENDERED;
          setTrimmed((t) => t + drop);
          const keptOffsets = [
            ...mergedOffsets.slice(0, protectedFront),
            ...mergedOffsets.slice(protectedFront + drop),
          ];
          entryOffsetsRef.current = keptOffsets;
          if (firstOffsetRef.current === null) {
            firstOffsetRef.current = keptOffsets[0] ?? 0;
          }
          return [
            ...merged.slice(0, protectedFront),
            ...merged.slice(protectedFront + drop),
          ];
        });
      });
    };

    const openStream = () => {
      if (stopped || es) return;
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      const url = `/api/sessions/${encodeURIComponent(run.sessionId)}/tail/stream?repo=${encodeURIComponent(run.repoPath)}&since=${offsetRef.current}`;
      try {
        es = new EventSource(url);
      } catch {
        return;
      }
      es.addEventListener("tail", (ev) => {
        if (stopped) return;
        try {
          const payload = JSON.parse((ev as MessageEvent).data);
          applyTail(payload);
        } catch { }
      });
      es.addEventListener("partial", (ev) => {
        if (stopped) return;
        try {
          const p = JSON.parse((ev as MessageEvent).data) as {
            messageId: string;
            index: number;
            text: string;
          };
          if (!p?.text) return;
          appendPartial(run.sessionId, p.messageId, p.text);
          setLastTs(Date.now());
        } catch { }
      });
      es.addEventListener("alive", (ev) => {
        if (stopped) return;
        try {
          const { alive } = JSON.parse((ev as MessageEvent).data) as { alive: boolean };
          setAliveSse(alive);
          if (!alive) {
            setActivity({ kind: "idle" });
            if (aliveSweepTimer) clearTimeout(aliveSweepTimer);
            aliveSweepTimer = setTimeout(() => {
              aliveSweepTimer = null;
              if (stopped) return;
              clearPartials(run.sessionId);
            }, 2000);
          }
        } catch { }
      });
      es.addEventListener("status", (ev) => {
        if (stopped) return;
        try {
          const s = JSON.parse((ev as MessageEvent).data) as {
            kind: "thinking" | "running" | "idle";
            label?: string;
          };
          if (s && (s.kind === "thinking" || s.kind === "running" || s.kind === "idle")) {
            setActivity({ kind: s.kind, label: s.label });
          }
        } catch { }
      });
    };

    const closeStream = () => {
      try { es?.close(); } catch { }
      es = null;
    };

    const onVis = () => {
      if (typeof document === "undefined") return;
      if (document.visibilityState === "hidden") {
        closeStream();
      } else {
        api.tail(run.sessionId, run.repoPath, offsetRef.current)
          .then((payload) => { if (!stopped) applyTail(payload); })
          .catch(() => { })
          .finally(() => openStream());
      }
    };
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", onVis);
    }

    openStream();
    return () => {
      stopped = true;
      if (aliveSweepTimer) {
        clearTimeout(aliveSweepTimer);
        aliveSweepTimer = null;
      }
      closeStream();
      if (typeof document !== "undefined") {
        document.removeEventListener("visibilitychange", onVis);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run?.sessionId, run?.repoPath]);

  const loadOlder = useCallback(async () => {
    if (!run) return;
    if (inFlightOlderRef.current) return;
    const cur = firstOffsetRef.current;
    if (cur === null || cur <= 0) return;
    const el = logRef.current;
    if (!el) return;
    inFlightOlderRef.current = true;
    setLoadingOlder(true);
    pendingScrollRestoreRef.current = {
      prevHeight: el.scrollHeight,
      prevTop: el.scrollTop,
    };
    try {
      const result = await api.tailBefore(run.sessionId, run.repoPath, cur);
      const olderLines = (result.lines ?? []) as LogEntry[];
      const olderOffsets = Array.isArray(result.lineOffsets) ? result.lineOffsets : [];
      if (olderLines.length === 0) {
        firstOffsetRef.current = result.fromOffset === 0 ? 0 : cur;
        pendingScrollRestoreRef.current = null;
        return;
      }
      const seen = new Set<string>();
      for (const e of entries) {
        if (e.uuid) seen.add(e.uuid);
      }
      const dedupOlder: LogEntry[] = [];
      const dedupOlderOffsets: number[] = [];
      for (let i = 0; i < olderLines.length; i++) {
        const l = olderLines[i];
        const id = l?.uuid;
        if (id && seen.has(id)) continue;
        if (id) seen.add(id);
        dedupOlder.push(l);
        dedupOlderOffsets.push(olderOffsets[i] ?? 0);
      }
      setEntries((prev) => [...dedupOlder, ...prev]);
      entryOffsetsRef.current = [...dedupOlderOffsets, ...entryOffsetsRef.current];
      loadedOlderCountRef.current += dedupOlder.length;
      firstOffsetRef.current = result.fromOffset;
      if (dedupOlder.length > 0) {
        setTrimmed((t) => Math.max(0, t - dedupOlder.length));
      }
    } catch {
      pendingScrollRestoreRef.current = null;
    } finally {
      inFlightOlderRef.current = false;
      setLoadingOlder(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run]);

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

  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [matchIdx, setMatchIdx] = useState(0);
  const [matchSeed, setMatchSeed] = useState(searchQuery);
  if (matchSeed !== searchQuery) {
    setMatchSeed(searchQuery);
    setMatchIdx(0);
  }
  const searchInputRef = useRef<HTMLInputElement>(null);

  const entryKey = useCallback((e: LogEntry, fallback: number): string => {
    return (
      e.uuid ||
      e.message?.id ||
      (e.timestamp ? `${e.timestamp}:${e.type ?? ""}` : `pos-${fallback}`)
    );
  }, []);

  const searchIndex = useMemo(
    () =>
      visibleEntries.map((e, i) => {
        const c = e.message?.content;
        const text = typeof c === "string" ? c : JSON.stringify(c ?? "");
        return { key: entryKey(e, i), text: text.toLowerCase() };
      }),
    [visibleEntries, entryKey],
  );

  const matchedKeys = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return [] as string[];
    const keys: string[] = [];
    for (const item of searchIndex) {
      if (item.text.includes(q)) keys.push(item.key);
    }
    return keys;
  }, [searchQuery, searchIndex]);

  const highlightTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (highlightTimerRef.current) clearTimeout(highlightTimerRef.current);
  }, []);
  const scrollToMatch = useCallback((idx: number) => {
    const k = matchedKeys[idx];
    if (!k) return;
    const sel = `[data-entry-key="${(typeof CSS !== "undefined" && CSS.escape ? CSS.escape(k) : k)}"]`;
    const el = logRef.current?.querySelector(sel) as HTMLElement | null;
    if (!el) return;
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    el.classList.add("ring-2", "ring-warning/60");
    if (highlightTimerRef.current) clearTimeout(highlightTimerRef.current);
    highlightTimerRef.current = setTimeout(() => {
      el.classList.remove("ring-2", "ring-warning/60");
      highlightTimerRef.current = null;
    }, 1400);
  }, [matchedKeys]);

  useEffect(() => {
    if (!searchOpen) return;
    if (matchedKeys.length === 0) return;
    scrollToMatch(matchIdx);
  }, [matchIdx, matchedKeys, scrollToMatch, searchOpen]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === "f") {
        if (!logRef.current) return;
        const r = logRef.current.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) return;
        e.preventDefault();
        setSearchOpen(true);
        setTimeout(() => searchInputRef.current?.focus(), 0);
      }
      if (e.key === "Escape" && searchOpen) {
        setSearchOpen(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [searchOpen]);

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

  const userTextOf = useCallback((e: LogEntry): string => {
    const blocks = asBlocks(e.message?.content);
    const raw = blocks
      .filter((b) => b.type === "text" && typeof b.text === "string")
      .map((b) => b.text!)
      .join(" ");
    const { stripped } = extractAttachments(raw);
    const cleaned = stripSystemTags(stripped);
    return cleaned.trim() || stripped.trim() || raw.trim();
  }, []);

  const lastUserText = useMemo(() => {
    for (let i = visibleEntries.length - 1; i >= 0; i--) {
      const e = visibleEntries[i];
      if (classify(e) !== "user") continue;
      const text = userTextOf(e);
      if (text) return text;
    }
    return "";
  }, [visibleEntries, userTextOf]);

  const pinnedUserText = useMemo(() => {
    if (autoScroll || !pinnedUserUuid) return lastUserText;
    for (const e of visibleEntries) {
      if (e.uuid !== pinnedUserUuid) continue;
      if (classify(e) !== "user") continue;
      const text = userTextOf(e);
      if (text) return text;
      break;
    }
    return lastUserText;
  }, [autoScroll, pinnedUserUuid, visibleEntries, lastUserText, userTextOf]);

  useLayoutEffect(() => {
    const restore = pendingScrollRestoreRef.current;
    if (!restore) return;
    const el = logRef.current;
    if (!el) {
      pendingScrollRestoreRef.current = null;
      return;
    }
    el.scrollTop = el.scrollHeight - restore.prevHeight + restore.prevTop;
    pendingScrollRestoreRef.current = null;
  }, [entries]);

  useEffect(() => {
    if (!autoScroll) return;
    if (pendingScrollRestoreRef.current) return;
    requestAnimationFrame(() => {
      if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
    });
  }, [visibleEntries, autoScroll]);

  const autoScrollRef = useRef(autoScroll);
  useEffect(() => {
    autoScrollRef.current = autoScroll;
  }, [autoScroll]);
  useEffect(() => {
    const el = logRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => {
      if (!autoScrollRef.current) return;
      if (pendingScrollRestoreRef.current) return;
      el.scrollTop = el.scrollHeight;
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const recomputePinnedUuid = useCallback(() => {
    const el = logRef.current;
    if (!el) return;
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
    const el = logRef.current;
    if (!el) return;
    const rows = el.querySelectorAll<HTMLDivElement>("[data-user-uuid]");
    if (rows.length === 0) return;
    const io = new IntersectionObserver(
      () => schedulePinnedRecalc(),
      { root: el, threshold: [0, 1] },
    );
    rows.forEach((r) => io.observe(r));
    schedulePinnedRecalc();
    return () => io.disconnect();
  }, [visibleEntries, schedulePinnedRecalc]);

  const handleScroll = useCallback(() => {
    const el = logRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    setAutoScroll(atBottom);
    if (
      el.scrollTop < 32 &&
      firstOffsetRef.current !== null &&
      firstOffsetRef.current > 0 &&
      !inFlightOlderRef.current
    ) {
      void loadOlder();
    }
    schedulePinnedRecalc();
  }, [loadOlder, schedulePinnedRecalc]);

  const scrollToBottom = useCallback(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
    setAutoScroll(true);
  }, []);

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
    [],
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
      offsetRef.current = 0;
      firstOffsetRef.current = null;
      entryOffsetsRef.current = [];
      loadedOlderCountRef.current = 0;
      inFlightOlderRef.current = false;
      pendingScrollRestoreRef.current = null;
      setEntries([]);
      setTrimmed(0);
      setPinnedUserUuid(null);
    } catch (e) {
      toast("error", (e as Error).message);
    }
  }, [run, toast, confirm]);

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
                setMatchIdx((i) => (e.shiftKey
                  ? (i - 1 + matchedKeys.length) % matchedKeys.length
                  : (i + 1) % matchedKeys.length));
              } else if (e.key === "Escape") {
                setSearchOpen(false);
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
            onClick={() => matchedKeys.length && setMatchIdx((i) => (i - 1 + matchedKeys.length) % matchedKeys.length)}
            disabled={matchedKeys.length === 0}
            className="p-1 rounded text-fg-dim hover:text-foreground disabled:opacity-40"
            title="Previous match (Shift+Enter)"
            aria-label="Previous match"
          >
            <ArrowUp size={12} />
          </button>
          <button
            type="button"
            onClick={() => matchedKeys.length && setMatchIdx((i) => (i + 1) % matchedKeys.length)}
            disabled={matchedKeys.length === 0}
            className="p-1 rounded text-fg-dim hover:text-foreground disabled:opacity-40"
            title="Next match (Enter)"
            aria-label="Next match"
          >
            <ArrowDown size={12} />
          </button>
          <button
            type="button"
            onClick={() => setSearchOpen(false)}
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
        <span className="font-medium whitespace-nowrap shrink-0">{run.role}</span>
        {repo && (
          <span className="text-muted-foreground whitespace-nowrap shrink-0">@ {repo.name}</span>
        )}
        {sessionTitle && (
          <span
            className="text-muted-foreground italic truncate min-w-0"
            title={sessionTitle}
          >
            · {sessionTitle}
          </span>
        )}
        {isResponding && (
          <span className="inline-flex items-center gap-1 text-warning text-[10.5px] whitespace-nowrap shrink-0">
            <span className="relative inline-flex h-1.5 w-1.5">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-warning opacity-60" />
              <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-warning" />
            </span>
            responding…
          </span>
        )}
        <div className="ml-auto flex items-center gap-1 shrink-0">
          {sessionTotals.turns > 0 && (
            <TokenUsage
              totals={sessionTotals}
              variant="compact"
              title={`This window: ${sessionTotals.turns} assistant turns · in ${sessionTotals.inputTokens.toLocaleString()} · out ${sessionTotals.outputTokens.toLocaleString()} · cache read ${sessionTotals.cacheReadTokens.toLocaleString()}`}
            />
          )}
          {}
          <button
            onClick={() => {
              setSearchOpen(true);
              setTimeout(() => searchInputRef.current?.focus(), 0);
            }}
            className="inline-flex items-center gap-1 h-7 w-7 md:w-auto md:px-1.5 md:h-6 justify-center rounded-md border border-border text-muted-foreground hover:text-foreground hover:bg-accent text-[10px] transition-colors"
            title="Search this conversation (Ctrl/⌘+F)"
            aria-label="Search conversation"
          >
            <Search size={11} />
            <span className="hidden md:inline">Search</span>
          </button>
          {}
          <button
            onClick={() => setShowTools((v) => !v)}
            className={`hidden md:inline-flex items-center gap-1 px-1.5 h-6 rounded-md border text-[10px] transition-colors ${
              showTools
                ? "border-border bg-secondary text-foreground"
                : "border-border text-muted-foreground hover:text-foreground hover:bg-accent"
            }`}
            title="Toggle tool results"
          >
            <Wrench size={10} /> {showTools ? "tools" : "no tools"}
          </button>
          <button
            onClick={() => {
              const md = exportSessionMarkdown(visibleEntries, {
                title: `Session ${run.sessionId.slice(0, 8)}`,
                sessionId: run.sessionId,
                repo: run.repo,
                role: run.role,
              });
              downloadFile(`session-${run.sessionId.slice(0, 8)}.md`, md);
            }}
            className="hidden md:inline-flex items-center gap-1 px-1.5 h-6 rounded-md border border-border text-muted-foreground hover:text-foreground hover:bg-accent text-[10px]"
            title="Export this conversation as Markdown"
          >
            <Download size={10} /> Export
          </button>
          <button
            onClick={copySessionId}
            className="hidden md:inline-flex items-center gap-1 text-muted-foreground hover:text-foreground font-mono text-[11px]"
            title="Copy session ID"
          >
            {run.sessionId.slice(0, 8)}…
            {copied ? <Check size={11} className="text-success" /> : <Copy size={11} />}
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
          {}
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
              <DropdownMenuItem
                onClick={() => {
                  const md = exportSessionMarkdown(visibleEntries, {
                    title: `Session ${run.sessionId.slice(0, 8)}`,
                    sessionId: run.sessionId,
                    repo: run.repo,
                    role: run.role,
                  });
                  downloadFile(`session-${run.sessionId.slice(0, 8)}.md`, md);
                }}
              >
                <Download size={12} />
                Export Markdown
              </DropdownMenuItem>
              <DropdownMenuItem onClick={copySessionId}>
                {copied ? <Check size={12} className="text-success" /> : <Copy size={12} />}
                <span className="font-mono">{run.sessionId.slice(0, 8)}…</span>
              </DropdownMenuItem>
              {onClearConversation && (
                <DropdownMenuItem onClick={onClearConversation}>
                  <RotateCw size={12} />
                  Clear conversation
                </DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </header>
      {}
      <div className="relative flex-1 min-h-0 min-w-0 flex flex-col">
        <div
          ref={logRef}
          onScroll={handleScroll}
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
                      toolNames={toolNames}
                      repo={run.repo}
                      prevTimestamp={visibleEntries[i - 1]?.timestamp}
                      canAnswer={!isResponding && i === pendingQuestionIdx && !!run.repo}
                      onAnswer={handleAnswer}
                    />
                  </div>
                );
              })}
              <StreamingPartialsList sessionId={run.sessionId} scrollerRef={logRef} autoScroll={autoScroll} />
            </>
          )}
        </div>
        </div>
        {!autoScroll && visibleEntries.length > 0 && (
          <button
            onClick={scrollToBottom}
            className="absolute bottom-3 right-4 z-20 inline-flex items-center gap-1 px-2.5 py-1 rounded-full bg-primary text-primary-foreground text-[11px] font-medium shadow-lg hover:bg-primary/90 animate-slide-in"
          >
            <ArrowDown size={11} /> Jump to latest
          </button>
        )}
      </div>

      <ActivityRow activity={activity} />

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
