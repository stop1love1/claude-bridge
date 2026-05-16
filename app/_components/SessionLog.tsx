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


/**
 * One row per .jsonl entry, but no per-entry "card" anymore — we let
 * the per-block components carry their own visual weight. User typed
 * messages get a right-aligned bubble (chat-style), assistant text
 * flows left as plain markdown, tool calls / results render compact
 * and dim. Keeps the chat skim-able.
 */
const LogRow = memo(function LogRow({
  entry,
  sessionId,
  onRewindToHere,
  toolNames,
  repo,
  prevTimestamp,
}: {
  entry: LogEntry;
  sessionId: string;
  onRewindToHere?: (uuid: string) => void;
  toolNames?: Map<string, string>;
  repo?: string;
  prevTimestamp?: string;
}) {
  const kind = classify(entry);
  if (kind === "hidden") return null;
  const blocks = asBlocks(entry.message?.content);
  const canRewind = kind === "user" && !!entry.uuid && !!onRewindToHere;

  // Right-aligned user bubble, ChatGPT/Claude style. Attachments are
  // pulled out and rendered as image previews / file chips above the text.
  // Three sources of images on a user message:
  //   - composer-upload `Attached file: \`<path>\`` text marker → AttachmentChip
  //   - inline `image` content blocks (paste, IDE attach, API direct) → InlineImage
  //   - none of the above + only text → plain bubble
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
    // Strip system-reminder / task-notification / IDE breadcrumbs etc.
    // before checking emptiness — if all that's left is scaffolding,
    // suppress the row entirely.
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

  // Tool result lives on a "user-typed" entry per Anthropic schema, but
  // we render it as a result line under the assistant's prior tool_use.
  // F.2: TodoWrite confirmations ("Todos have been modified successfully…")
  // are pure ceremony — suppress them. The tool_use block carries the
  // actual list, which renders fine.
  if (kind === "tool_result") {
    const rendered = blocks
      .map((b, i) => {
        if (b.type !== "tool_result") return null;
        const tuid = b.tool_use_id ?? "";
        const name = tuid && toolNames ? toolNames.get(tuid) : undefined;
        const suppress = name === "TodoWrite";
        // Stable key: tool_use_id pairs each result to its unique
        // tool_use call. Falling back to index is fine when the model
        // emitted a result without an id (rare malformed payloads).
        const key = tuid || `idx-${i}`;
        return <ToolResultView key={key} block={b} suppress={suppress} repo={repo} />;
      })
      .filter(Boolean);
    if (rendered.length === 0) return null;
    return <div className="my-0.5">{rendered}</div>;
  }

  // Assistant: render every block flush-left, no card. Multiple blocks
  // (text + tool_use chain) hang together visually because they share
  // the entry-level vertical margin.
  // F.6: merge adjacent text blocks into a single MarkdownText render so
  // a paragraph that the model emitted as `text, text, text` renders as
  // one flowing block (instead of three separately-margined rows).
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
  // Approximate the model's thinking duration as the wall-clock gap
  // between the prior entry (typically the user message that triggered
  // this turn) and this assistant entry. It rolls in any tool wait
  // time too, but for a single-turn thought it's the closest signal we
  // have without per-token stream timing.
  const thoughtDurationSec = (() => {
    if (!prevTimestamp || !entry.timestamp) return undefined;
    const a = Date.parse(prevTimestamp);
    const b = Date.parse(entry.timestamp);
    if (!Number.isFinite(a) || !Number.isFinite(b) || b <= a) return undefined;
    return (b - a) / 1000;
  })();
  // Surface non-routine stop reasons. `end_turn` and `tool_use` are the
  // expected paths (model finished or yielded for a tool); anything else
  // (`max_tokens`, `refusal`, `stop_sequence`, `pause_turn`) means the
  // reply was cut short or model declined — the user needs to know the
  // bubble above isn't a complete answer.
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
        return <ToolUseView key={i} block={m.block} />;
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
  // Re-render only when meaningful inputs change. `toolNames` is rebuilt
  // on every entries-tick, but it's only consulted by tool_result rows;
  // for everything else its identity flip is noise. Compare by entry
  // identity + sessionId + the tool-names lookup result for any
  // tool_use_id this entry references.
  if (prev.entry !== next.entry) return false;
  if (prev.sessionId !== next.sessionId) return false;
  if (prev.onRewindToHere !== next.onRewindToHere) return false;
  if (prev.repo !== next.repo) return false;
  if (prev.prevTimestamp !== next.prevTimestamp) return false;
  // Pull tool_use_ids that this entry's tool_result blocks point at and
  // compare their resolved names. If the entry doesn't have any, the
  // toolNames prop is irrelevant.
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

/**
 * Subscribes to the streaming-partial key set for `sessionId` and
 * renders one `StreamingPartialRowConnected` per active key. The key
 * set changes only when a streaming message starts or finishes; pure
 * text growth on an existing key does NOT change the key set, so this
 * list itself doesn't re-render on token deltas — only the individual
 * row whose text grew does.
 *
 * `scrollerRef` + `autoScroll` are forwarded so the streaming row can
 * pin the parent's bottom edge as text grows. We do that here (rather
 * than a generic `useEffect([partials])` in `SessionLogInner`) precisely
 * because the latter would defeat the whole point of lifting partials
 * out — it would re-run on every token tick.
 */
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

/**
 * One streaming "ghost" assistant row, wired to its own slot in the
 * partials store. Renders `StreamingAssistantRow` with the live text
 * and pins the parent scroller's bottom edge as the text grows so the
 * tail doesn't slide behind the composer. Only this component re-renders
 * on token deltas — siblings (the canonical chat rows) are unaffected.
 */
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
  // Pin the bottom edge each time our text grows. Reading the latest
  // `autoScroll` through a ref so the effect doesn't tear down on every
  // toggle — keeps scroll behavior in step with the user's preference.
  const autoScrollRef = useRef(autoScroll);
  useEffect(() => { autoScrollRef.current = autoScroll; }, [autoScroll]);
  useEffect(() => {
    if (!autoScrollRef.current) return;
    const el = scrollerRef.current;
    if (!el) return;
    // RAF so the layout pass that placed our updated text is settled
    // before we measure scrollHeight.
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

/**
 * Placeholder shown while a session has no entries and no streaming
 * partial yet. Switches copy at 30s so the operator knows the spawn is
 * taking longer than usual and where to look for errors. Subscribes to
 * the same key set as `StreamingPartialsList` so the placeholder
 * vanishes the moment the first token arrives — without forcing
 * `SessionLogInner` itself to subscribe (and thereby re-render on every
 * token tick).
 */
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
    // Remount on session change so the 30s timer restarts each time
    // the operator opens a different run — otherwise `stalled` from a
    // previous spawn would carry over and we'd lie to the user.
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
  // Live token-streaming buffers live in `partialsStore` (a module-level
  // `useSyncExternalStore` source) keyed by sessionId+messageId. Lifting
  // them out of SessionLogInner's `useState` keeps token deltas (~50/s
  // on a long reply) from re-reconciling the entire 300-row chat tree —
  // only the streaming "ghost" row subscribes to its own buffer, and a
  // small list-of-keys subscriber drives the row map. The remount-on-
  // session-change wrapper ensures store entries from a previous session
  // are dropped via the GC inside `subscribePartialKeys.subscribe`.
  // Server-reported child-process state. null until the first `alive`
  // SSE event arrives — until then we fall back to the lastTs heuristic
  // so the UI doesn't lose its responding indicator on a stream blip.
  const [aliveSse, setAliveSse] = useState<boolean | null>(null);
  // "Thinking… / Running <bash>…" indicator, fed by the claude
  // stream-json `system/status` and `system/task_started` events.
  // Mirrors the bottom line of the Claude Code CLI's terminal screen.
  const [activity, setActivity] = useState<{
    kind: "thinking" | "running" | "idle";
    label?: string;
  }>({ kind: "idle" });
  const offsetRef = useRef(0);
  // Byte offset of the FIRST loaded line. null = nothing loaded yet,
  // 0 = we've reached the start of the file. Anything > 0 means we
  // have older history we could fetch.
  const firstOffsetRef = useRef<number | null>(null);
  // Byte offsets parallel to `entries`, so cap-trimming on forward
  // growth can keep `firstOffsetRef` in sync.
  const entryOffsetsRef = useRef<number[]>([]);
  // How many of the FRONT entries arrived via backward paging. The
  // forward-tick cap MUST NOT trim these — that would yo-yo the user
  // back to the bottom every second.
  const loadedOlderCountRef = useRef(0);
  const inFlightOlderRef = useRef(false);
  // Scroll-restoration handoff: the backward fetch sets prevHeight here,
  // and the layout effect after re-render restores scrollTop.
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
    // State + ref resets are handled by remounting via the
    // `key={sessionId}` wrapper in `SessionLog` (see export below). DO
    // NOT reset offsetRef / firstOffsetRef / entryOffsetsRef etc. here:
    // under React Strict Mode (and Turbopack HMR) this effect re-runs
    // on the SAME instance, so `entries` state survives but resetting
    // the refs would put `offsetRef=0` against a populated `entries`.
    // The next SSE would then open with `since=0`, replay every line
    // we already have, and applyTail would append them all again —
    // producing duplicate `uuid` keys (and React's duplicate-children
    // warning). Fresh mounts get correct ref initial values from the
    // `useRef(...)` calls, so no init code is needed here.
    if (!run) return;

    let stopped = false;
    let es: EventSource | null = null;
    // SSE-driven timers we own and must clear on unmount / re-run. The
    // `alive: false` handler schedules a delayed sweep of the live
    // streaming buffer; without storing the handle, an unmount or a
    // visibility flip would let the callback fire on a stale closure
    // and clobber `partials` of the next mount (CRIT-6).
    let aliveSweepTimer: ReturnType<typeof setTimeout> | null = null;

    /**
     * Apply a `{ lines, offset, lineOffsets }` payload — same merge
     * shape as the REST `/tail` response, used both by the SSE handler
     * and the visibility-flip catch-up REST call.
     */
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
      // Canonical assistant line → drop the matching live-streaming
      // buffer so the rendered ghost row collapses into the real one.
      // Also drop sentinel `live:*` ids whenever any assistant line
      // lands; they were only there because the parser hadn't seen
      // message_start yet.
      const arrivedAssistant = lines.some((l) => l?.type === "assistant");
      if (arrivedAssistant) {
        const arrivedIds: string[] = [];
        for (const l of lines) {
          const id = l?.message?.id;
          if (typeof id === "string") arrivedIds.push(id);
        }
        dropOnArrival(run.sessionId, arrivedIds);
      }
      // Drop optimistic user rows the moment any real user entry
      // lands via tail: the canonical `.jsonl`-backed row supersedes
      // the synthetic one onSent inserted. Conservative — we only
      // strip optimistic rows when the incoming batch actually
      // contains a user line; an assistant-only tail shouldn't clear
      // a still-pending user optimistic (e.g. when the prior turn
      // emits a late tool_result and the next user message hasn't
      // been written yet).
      const arrivedUser = lines.some((l) => l?.type === "user");
      startTransition(() => {
        setEntries((prev) => {
          const baseline = arrivedUser
            ? prev.filter((e) => !(e.uuid && e.uuid.startsWith("optimistic:")))
            : prev;
          // Dedup by JSONL `uuid` against entries we already have. Belt-
          // and-braces against any path that re-delivers a line we've
          // already merged: SSE auto-reconnect racing the offset advance,
          // visibility-flip catch-up REST overlapping the next SSE
          // payload, server replay on a stale `since`, etc. Without this
          // a single duplicated line surfaces as React's "two children
          // with the same key" warning at the entry-render site (the
          // `<div key={key}>` derived from `e.uuid`).
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
          // No new lines AND no optimistic rows were stripped — keep
          // the prior reference to avoid a needless re-render.
          if (dedupLines.length === 0 && baseline.length === prev.length) return prev;

          const merged = [...baseline, ...dedupLines];
          const mergedOffsets = [
            ...entryOffsetsRef.current,
            ...dedupOffsets,
          ];
          // Cap accounting: never trim the FRONT entries that came in
          // via a backward load. Trim only the post-prefix tail-window
          // beyond MAX_RENDERED.
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

    /**
     * Open an SSE connection. Reopens automatically on tab-visible
     * after a hidden close. We pass `since=offsetRef.current` so a
     * reconnect doesn't replay history we already have. EventSource's
     * built-in auto-reconnect handles transient network drops.
     */
    const openStream = () => {
      if (stopped || es) return;
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
        } catch { /* malformed — ignore */ }
      });
      // Token-by-token streaming from claude's stream-json output. Each
      // payload is a small text fragment; we accumulate them by message
      // id so the ghost assistant row keeps growing until the canonical
      // .jsonl line lands and prunes the buffer.
      es.addEventListener("partial", (ev) => {
        if (stopped) return;
        try {
          const p = JSON.parse((ev as MessageEvent).data) as {
            messageId: string;
            index: number;
            text: string;
          };
          if (!p?.text) return;
          // Per-message cap (~256 KB) is enforced inside the store so a
          // pathologically long reply can't pin React state. The store
          // notifies only the streaming row's subscriber — the rest of
          // the tree never re-renders on token deltas.
          appendPartial(run.sessionId, p.messageId, p.text);
          // Treat partial deltas as activity for the responding-indicator
          // fallback so the indicator stays warm on long replies.
          setLastTs(Date.now());
        } catch { /* malformed — ignore */ }
      });
      // Process lifecycle. Drives the Stop button — without this the
      // button would vanish during long tool calls, since the previous
      // 4-second-since-last-tail heuristic couldn't tell "subprocess
      // is busy thinking" apart from "subprocess died".
      es.addEventListener("alive", (ev) => {
        if (stopped) return;
        try {
          const { alive } = JSON.parse((ev as MessageEvent).data) as { alive: boolean };
          setAliveSse(alive);
          // When the process exits without ever writing a canonical
          // assistant line (rare: crash mid-turn / killed by Stop), the
          // ghost row would otherwise sit forever. Sweep partials a
          // couple of seconds after exit.
          if (!alive) {
            setActivity({ kind: "idle" });
            if (aliveSweepTimer) clearTimeout(aliveSweepTimer);
            aliveSweepTimer = setTimeout(() => {
              aliveSweepTimer = null;
              if (stopped) return;
              clearPartials(run.sessionId);
            }, 2000);
          }
        } catch { /* malformed — ignore */ }
      });
      // Activity indicator — claude's `system/status` and
      // `system/task_started` events arrive here so the UI can show
      // "Thinking…" / "Running: <description>" between the chat log
      // and the composer.
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
        } catch { /* malformed — ignore */ }
      });
      // EventSource auto-reconnects on transient errors; we just stay
      // quiet and let the browser handle it. Persistent failure (server
      // unreachable) will keep firing `error` but doesn't need our help.
    };

    const closeStream = () => {
      try { es?.close(); } catch { /* ignore */ }
      es = null;
    };

    // Tab hidden → drop the connection so an idle session tab doesn't
    // hold an open HTTP/1.1 SSE slot (browsers cap to 6/origin). On
    // re-show, reopen and (one-shot) REST-tail any bytes we missed
    // while disconnected — SSE only pushes events that fired during
    // the connection.
    const onVis = () => {
      if (typeof document === "undefined") return;
      if (document.visibilityState === "hidden") {
        closeStream();
      } else {
        // Catch up on whatever landed while we were hidden, THEN reopen
        // the stream from the new offset.
        api.tail(run.sessionId, run.repoPath, offsetRef.current)
          .then((payload) => { if (!stopped) applyTail(payload); })
          .catch(() => { /* ignore */ })
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
    // We intentionally key on `run.sessionId` + `run.repoPath` — the only
    // identifying fields. A whole-`run`-object dep would re-tear-down the
    // SSE on every parent re-render that produced a new object identity,
    // even when the underlying session hasn't changed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run?.sessionId, run?.repoPath]);

  // Backward fetch: load a chunk of older entries and prepend.
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
        // Nothing more upstream → mark exhausted.
        firstOffsetRef.current = result.fromOffset === 0 ? 0 : cur;
        pendingScrollRestoreRef.current = null;
        return;
      }
      // Prepend — dedup against the parallel offsets ref by `uuid`
      // first. Same motivation as `applyTail`'s dedup: if the backward
      // window overlaps the head of `entries` by even one line
      // (server-side boundary off-by-one, a race with a freshly-arrived
      // tail), we'd otherwise produce two entries with the same key
      // and trip React's duplicate-children warning.
      //
      // We dedup using the closure `entries` (not `prev` inside the
      // updater) so side-effects (ref / counter / setTrimmed) run
      // exactly once per loadOlder call, not once per StrictMode
      // re-invocation. Older-window vs. tail-window come from opposite
      // ends of the file, so closure staleness can't cause a missed
      // dedup in practice.
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
      // We just resurrected entries that the cap had previously dropped —
      // shrink the "earlier entries trimmed" counter to match the actual
      // number of new rows we kept.
      if (dedupOlder.length > 0) {
        setTrimmed((t) => Math.max(0, t - dedupOlder.length));
      }
    } catch {
      pendingScrollRestoreRef.current = null;
    } finally {
      inFlightOlderRef.current = false;
      setLoadingOlder(false);
    }
    // `entries` is read above for dedup but intentionally excluded from
    // the dep list — adding it would re-create `loadOlder` on every
    // entries change, which cascades into `handleScroll` (deps include
    // `loadOlder`) and forces a per-batch re-bind of the scroll handler.
    // The dedup correctness doesn't need a fresh snapshot: older-window
    // and tail-window come from opposite ends of the file, so even a
    // few-batches-stale closure can't miss a real duplicate.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run]);

  // "responding…" if a new entry landed in the last 4s. Lazy
  // initializer so React's purity rule (`Date.now()` is impure) is
  // satisfied — the wall clock is read once on mount, then ticked by
  // the effect below.
  const [now, setNow] = useState(() => Date.now());
  // Stop the per-second tick once the SSE alive flag is the
  // authoritative source — at that point `isResponding` no longer
  // reads `now` and the re-render is wasted CPU per session per tab.
  useEffect(() => {
    if (aliveSse !== null) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [aliveSse]);
  // Authoritative source: the SSE-reported child-process state. Falls
  // back to the legacy lastTs heuristic only until the first `alive`
  // event arrives (e.g. on a brand-new SSE connection in dev), so the
  // Stop button is no longer at the mercy of "did claude write a line
  // in the last 4s" — long Bash calls / model thinking gaps used to
  // make it disappear mid-turn.
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

  // -- Chat search (Cmd/Ctrl+F) --
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [matchIdx, setMatchIdx] = useState(0);
  // Reset matchIdx whenever the search query changes — done as a
  // "previous-snapshot" compare during render (per React docs §
  // "storing information from previous renders") so we don't trip the
  // `set-state-in-effect` rule with `useEffect(setMatchIdx)`.
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

  // Pre-index the search text once per `visibleEntries` change so the
  // per-keystroke filter is a simple lowercase substring test rather
  // than re-stringifying every entry's content blob on every keystroke.
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

  // Track the most recent highlight timer so a fast next-match jump (or
  // an unmount) clears the previous element's pending class removal —
  // otherwise the callback can fire on a stale or unmounted DOM node.
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
        // Only intercept when the chat panel is in the visible viewport
        // (ignore when user is in another part of the app).
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

  // Sum per-turn `message.usage` across loaded entries. The window is
  // bounded by MAX_RENDERED, so this is a *running* total over what's
  // currently in memory — not the full session. The number is still
  // useful for "how big is this conversation getting?" while typing,
  // and the task-level endpoint covers full-session totals.
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

  // Most-recent `ai-title` Claude Code wrote into the .jsonl. Used as a
  // human-readable session label in the header — replaces "session
  // 4fdb723a…" with e.g. "Fix sessions page loading issue". Walks back
  // (`findLast`) because the model can refresh the title mid-conversation.
  const sessionTitle = useMemo(
    () => entries
      .findLast(
        (e) => e.type === "ai-title" && typeof e.aiTitle === "string" && e.aiTitle.trim().length > 0,
      )
      ?.aiTitle?.trim() ?? null,
    [entries],
  );

  // Map every `tool_use_id` we've seen to its tool `name` so tool_result
  // blocks can look up which tool they are answering. Used for F.2
  // (suppressing TodoWrite confirmation noise).
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

  // The most-recent typed-user message is what gets shown in the
  // sticky bar at the top of the scroll container so the question
  // stays visible while reading tool results / assistant replies.
  // We strip the `Attached file:` boilerplate from the pinned preview
  // so it's the actual question that's visible, not the file headers.
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

  // Text from whichever user-message has currently scrolled above the
  // top edge. Falls through to `lastUserText` when nothing's crossed
  // yet, or when the reader is pinned to the bottom (autoScroll mode).
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

  // After a backward-load prepends rows, the scroll container's
  // scrollHeight grew by N px upstream of the user's previous viewport.
  // To prevent a jarring jump, restore the offset from the bottom:
  //   newTop = newHeight - prevHeight + prevTop
  // useLayoutEffect runs synchronously after DOM mutation, before the
  // browser paints — so the user never sees the wrong scrollTop frame.
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
    // Skip auto-scroll-to-bottom if a backward load is mid-flight; the
    // layout effect above is repositioning the viewport.
    if (pendingScrollRestoreRef.current) return;
    requestAnimationFrame(() => {
      if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
    });
    // Streaming-token-driven autoscroll is handled in
    // `<StreamingPartialsList>` below — the streaming row observes its
    // own resize and pins the parent's bottom edge as text grows. That
    // keeps SessionLogInner itself out of the per-token re-render loop.
  }, [visibleEntries, autoScroll]);

  // Sibling rows below the scroll panel (ActivityRow flipping out of
  // idle, InlinePermissionRequests appearing, the composer growing
  // when the user expands the textarea) shrink the scroller's
  // clientHeight without firing a scroll event. When that happens
  // mid-conversation, the last line of the latest message ends up
  // hidden behind those rows even though `autoScroll` is still on.
  // Re-pin the bottom on every viewport resize so the tail stays in
  // view. We read `autoScroll` through a ref to avoid tearing the
  // observer down on every toggle.
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

  // rAF-throttled re-evaluation of which user uuid currently sits "above
  // the top edge of the viewport" — i.e., the most recent user message
  // the reader has scrolled past. Falls back to lastUserText when nothing
  // has scrolled past yet (handled at render time).
  const recomputePinnedUuid = useCallback(() => {
    const el = logRef.current;
    if (!el) return;
    const containerTop = el.getBoundingClientRect().top;
    // Sticky header sits at containerTop and is ~28px tall; treat the
    // edge of "scrolled past" as just under it. Add a small fudge so the
    // pinned label flips at the same moment the user crosses the line.
    const threshold = containerTop + 4;
    const rows = el.querySelectorAll<HTMLDivElement>("[data-user-uuid]");
    let pickUuid: string | null = null;
    for (const row of rows) {
      const r = row.getBoundingClientRect();
      // Pick the LAST user-row whose bottom edge is at or above the top
      // threshold — i.e., the most recent message that has fully
      // scrolled past the fold.
      if (r.bottom <= threshold) {
        const uuid = row.getAttribute("data-user-uuid") || "";
        if (uuid) pickUuid = uuid;
      } else {
        break; // rows are in document order; the rest are below us.
      }
    }
    setPinnedUserUuid((prev) => (prev === pickUuid ? prev : pickUuid));
  }, []);

  // Drive recomputePinnedUuid from both an IntersectionObserver (cheap,
  // covers most cases) and a scroll listener (covers fast scrolls IO
  // would skip over). Both go through one rAF latch to avoid setState
  // storms.
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
    // Run once immediately so the pin reflects the current scroll state
    // even if no rows actually crossed an edge yet.
    schedulePinnedRecalc();
    return () => io.disconnect();
  }, [visibleEntries, schedulePinnedRecalc]);

  const handleScroll = useCallback(() => {
    const el = logRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    setAutoScroll(atBottom);
    // Backward-load trigger: at top, with older history available.
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
      // Optimistic user-message render: append a synthetic entry
      // immediately so the user sees their message in the log instead
      // of staring at an unchanged transcript while the server spins
      // up. `uuid` is prefixed `optimistic:` so the dedup pass in
      // applyTail can recognize + drop these the moment the real
      // .jsonl-backed entry arrives via tail (see "drop optimistic
      // rows" branch above). Skip when the user only sent attachments
      // (live text empty) — the file chip flow already gives feedback.
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
          {/* Search — visible on every viewport. Icon-only on mobile to
              save space; label appears from md+. h-7 / w-7 keeps a
              comfortable touch target on phones. */}
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
          {/* md+ — secondary actions inline. On mobile they collapse
              into the kebab below to keep the header on one line. */}
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
          {/* Mobile-only kebab — bundles Tools toggle, Export, and Copy
              session ID so the header stays one line on phones. h-7/w-7
              gives a finger-friendly tap target. */}
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
      {/* Wrapper holds the chat scroller AND its floating "Jump to latest"
          pill. Anchoring the pill here (instead of on the outer section)
          keeps it above the activity / composer rows below — otherwise
          its `bottom-N` lands on top of the ActivityRow's `border-t`
          and looks like a strikethrough. `overflow-x-hidden` is the
          belt to inline-code's suspenders: even if a renderer-quirk
          slips a non-wrapping span through, it gets clipped instead of
          forcing the whole pane to scroll sideways on mobile. */}
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
                // H10: derive a STABLE key from the entry itself. The
                // previous `trimmed + i` formulation was not stable
                // across cap-trimming — when N front entries were
                // dropped, the index reset while `trimmed` advanced,
                // so unrelated entries collided on the same key. React
                // then reused DOM nodes (and therefore each LogRow's
                // memoised inner state, e.g. `ToolResultView`'s `open`)
                // across entries. Anthropic JSONL always sets `uuid`
                // per line, but we belt-and-brace to message.id and
                // timestamp+type before falling back to a positional
                // composite that at least no longer recycles after
                // trim.
                const key =
                  e.uuid ||
                  e.message?.id ||
                  (e.timestamp ? `${e.timestamp}:${e.type ?? ""}` : `pos-${trimmed + i}`);
                // Optimistic rows (synthetic user messages added by
                // onSent before the .jsonl echoes back) read at 70%
                // opacity so the user sees their message instantly
                // but knows it's not yet persisted. Once the tail
                // event arrives, the optimistic row is dropped and
                // the canonical entry takes over at full opacity.
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

/**
 * Outer wrapper that keys the memo'd inner on the active session
 * identity. Switching to a different session forces a full remount
 * — every `useState` re-runs its initializer and every `useRef`
 * gets a fresh slot — so we don't need a `setEntries([])`-style
 * state-reset prologue in `useEffect` (which the React 19 hooks
 * linter flags as a cascading-render risk).
 */
export function SessionLog(props: {
  run: ActiveRun | null;
  repos: Repo[];
  taskId?: string;
  onClearConversation?: () => void;
}) {
  const k = `${props.run?.sessionId ?? "__none__"}|${props.run?.repoPath ?? ""}`;
  return <SessionLogMemo key={k} {...props} />;
}
