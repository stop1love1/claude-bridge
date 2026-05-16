"use client";

import { memo, useCallback, useEffect, useRef, useState } from "react";
import { Send, Loader2, Square, Image as ImageIcon, FileText, X } from "lucide-react";
import { api } from "@/libs/client/api";
import { useLocalStorage } from "@/libs/client/useLocalStorage";
import { useToast } from "./Toasts";
import { ChatSettingsMenu } from "./ChatSettingsMenu";
import { QuickAddMenu } from "./ActionsMenu";
import { SlashActionsPalette } from "./SlashActionsPalette";
import { MentionPicker, type MentionMatch } from "./MentionPicker";
import { MicButton } from "./MicButton";
import type { ChatSettings } from "@/libs/client/types";

const MIN_H = 34;
const MAX_H = 220;
const STORAGE_KEY = "bridge.chat.settings";
// Operator opt-in: when `NEXT_PUBLIC_BRIDGE_ALLOW_BYPASS=1` is set, treat
// "Skip permissions" as the implicit default for any session that has
// not yet picked a mode. Otherwise a brand-new task starts in `default`
// (Ask-before-edits) and the user keeps seeing the popup despite having
// opted in at the env layer. Explicit picks still win — the loader only
// fills in the mode when the stored object has none.
const COMPOSER_DEFAULT_MODE =
  process.env.NEXT_PUBLIC_BRIDGE_ALLOW_BYPASS === "1" ? "bypassPermissions" : undefined;
const EMPTY_SETTINGS: ChatSettings = COMPOSER_DEFAULT_MODE
  ? { mode: COMPOSER_DEFAULT_MODE }
  : {};
const dumpSettings = (s: ChatSettings) => JSON.stringify(s);

interface Attachment {
  name: string;
  path: string;
  size: number;
  isImage: boolean;
  /** Pixel dimensions for images, populated client-side after upload. */
  width?: number;
  height?: number;
}

const IMG_EXT = /\.(png|jpe?g|gif|webp|svg|bmp|avif)$/i;

/**
 * Read pixel dimensions from a File without uploading. Returns null
 * for non-images or unreadable files.
 */
function readImageDimensions(file: File): Promise<{ w: number; h: number } | null> {
  if (!file.type.startsWith("image/") && !IMG_EXT.test(file.name)) {
    return Promise.resolve(null);
  }
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const img = new window.Image();
    img.onload = () => {
      resolve({ w: img.naturalWidth, h: img.naturalHeight });
      URL.revokeObjectURL(url);
    };
    img.onerror = () => {
      resolve(null);
      URL.revokeObjectURL(url);
    };
    img.src = url;
  });
}

function settingsKey(taskId?: string): string {
  // Per-task settings live under their own key so a task-specific
  // override (e.g. `effort: max` for a heavy refactor) doesn't leak
  // into a sibling task. Free-form sessions keep the legacy key so
  // existing prefs survive the upgrade.
  return taskId ? `${STORAGE_KEY}.task.${taskId}` : STORAGE_KEY;
}

function MessageComposerInner({
  sessionId,
  repo,
  // Kept in the prop signature so the parent can pass it for future
  // features (e.g. context-aware mention completion); not consumed yet.
  repoPath: _repoPath,
  role,
  taskId,
  isResponding = false,
  onSent,
  onClearConversation,
  onRewindRequest,
}: {
  sessionId: string;
  repo: string;
  repoPath?: string;
  role: string;
  taskId?: string;
  /** Claude is mid-response (a tail event landed within the last few
   *  seconds). When true, the Send button is replaced with a Stop
   *  button that SIGTERMs the underlying claude subprocess. */
  isResponding?: boolean;
  onSent?: () => void;
  onClearConversation?: () => void;
  onRewindRequest?: () => void;
}) {
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [stopping, setStopping] = useState(false);
  /**
   * Local mirror of the server-side message queue length. Bumped each
   * time `api.sendMessage` returns `queued: true`, decremented when
   * the in-flight turn flips idle (assumes the server drained one,
   * which it does — first-in-first-out). Also reset to 0 on Stop
   * because the kill route clears the queue server-side. Pure UX
   * surface; doesn't affect submit behavior.
   */
  const [queuedCount, setQueuedCount] = useState(0);
  // Settings come from localStorage via `useSyncExternalStore` so the
  // SSR snapshot ({}) and the client snapshot (real prefs) align
  // through React's external-store machinery — no `useState +
  // useEffect(setX)` pair to trigger React 19's set-state-in-effect
  // rule. The custom loader honours the legacy "fall back to the
  // global key on first render of a brand-new task" behaviour.
  const loadComposerSettings = useCallback(
    (raw: string | null): ChatSettings => {
      // Apply the env-based default mode if the loaded object doesn't
      // have one yet. Without this, a stored `{effort: "high"}` from an
      // older session leaves `mode` undefined and the request falls back
      // to "default" on the server even though BRIDGE_ALLOW_BYPASS is on.
      const withDefaultMode = (s: ChatSettings): ChatSettings =>
        s.mode === undefined && COMPOSER_DEFAULT_MODE
          ? { ...s, mode: COMPOSER_DEFAULT_MODE }
          : s;
      if (raw) {
        try { return withDefaultMode(JSON.parse(raw) as ChatSettings); } catch { /* fallthrough */ }
      }
      if (taskId && typeof window !== "undefined") {
        try {
          const fallback = window.localStorage.getItem(STORAGE_KEY);
          if (fallback) return withDefaultMode(JSON.parse(fallback) as ChatSettings);
        } catch { /* fallthrough */ }
      }
      return EMPTY_SETTINGS;
    },
    [taskId],
  );
  const [settings, setSettings] = useLocalStorage<ChatSettings>(
    settingsKey(taskId),
    loadComposerSettings,
    EMPTY_SETTINGS,
    dumpSettings,
  );
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<{ name: string; pct: number } | null>(null);
  const [mention, setMention] = useState<{ start: number; query: string } | null>(null);
  const [interim, setInterim] = useState("");
  const [slashPaletteOpen, setSlashPaletteOpen] = useState(false);
  /** Bumps only when "/" opens the palette so the subtree remounts with a cleared filter (controlled open skips Radix open handler). */
  const [slashPaletteMountKey, setSlashPaletteMountKey] = useState(0);
  const lastSentRef = useRef<string>("");
  const taRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const toast = useToast();

  /** True when caret is at the start of a line (whole message or after newline), optionally with leading spaces — matches where Claude opens the `/` palette. */
  const isCaretAtLogicalLineStart = useCallback((beforeCaret: string) => {
    const ls = beforeCaret.lastIndexOf("\n") + 1;
    return beforeCaret.slice(ls).trim() === "";
  }, []);

  // Stop the in-flight claude subprocess for this session. 404 ("no
  // live process") is benign — the run finished a moment ago and the
  // registry already cleaned up. Anything else is surfaced as a toast.
  // Always reset the local queued counter — the kill route clears the
  // server-side queue, so the badge would otherwise lie.
  const handleStop = useCallback(async () => {
    if (stopping) return;
    setStopping(true);
    try {
      await api.killSession(sessionId);
      setQueuedCount(0);
    } catch (err) {
      const msg = (err as Error).message;
      if (!msg.includes("404")) toast("error", msg);
    } finally {
      setStopping(false);
    }
  }, [sessionId, stopping, toast]);

  // Decrement the queue badge when the in-flight turn flips idle: the
  // server drains one queued message per exit, so each `isResponding`
  // edge from true→false consumes exactly one slot. We can't observe
  // the drain directly (it's a server-side child exit + spawn) but
  // FIFO discipline + this edge detector keeps the badge in sync
  // without any extra round trip. Hard floor at 0 — the counter is a
  // hint, never authoritative.
  const prevRespondingRef = useRef(isResponding);
  useEffect(() => {
    if (prevRespondingRef.current && !isResponding) {
      setQueuedCount((n) => Math.max(0, n - 1));
    }
    prevRespondingRef.current = isResponding;
  }, [isResponding]);

  const resize = useCallback(() => {
    const el = taRef.current;
    if (!el) return;
    el.style.height = "0px";
    const natural = el.scrollHeight;
    const h = Math.min(MAX_H, Math.max(MIN_H, natural));
    el.style.height = `${h}px`;
    // Phantom scrollbar fix: when content fits the auto-grown height,
    // suppress the scrollbar entirely. Browsers (esp. Windows Chrome at
    // fractional DPI) round scrollHeight up by 1px on an empty textarea
    // and render a useless scroll track. Only re-enable scrolling when
    // we actually clamped to MAX_H.
    el.style.overflowY = natural > MAX_H ? "auto" : "hidden";
  }, []);
  useEffect(resize, [draft, interim, resize]);

  // -- Mention detection: track caret position vs the most recent `@`.
  const detectMention = useCallback(() => {
    const el = taRef.current;
    if (!el) return;
    const caret = el.selectionStart ?? 0;
    const upTo = draft.slice(0, caret);
    const at = upTo.lastIndexOf("@");
    if (at < 0) { setMention(null); return; }
    // require @ to be at start or after whitespace
    const prev = at === 0 ? " " : upTo[at - 1];
    if (!/\s/.test(prev)) { setMention(null); return; }
    const after = upTo.slice(at + 1);
    if (/\s/.test(after)) { setMention(null); return; }
    setMention({ start: at, query: after });
  }, [draft]);

  useEffect(() => { detectMention(); }, [draft, detectMention]);

  const insertMention = useCallback((m: MentionMatch) => {
    const el = taRef.current;
    if (!el) return;
    const caret = el.selectionStart ?? draft.length;
    const at = mention?.start ?? caret;
    const before = draft.slice(0, at);
    const after = draft.slice(caret);
    const inserted = `@${m.rel} `;
    const next = before + inserted + after;
    setDraft(next);
    setMention(null);
    requestAnimationFrame(() => {
      const newCaret = before.length + inserted.length;
      el.focus();
      el.setSelectionRange(newCaret, newCaret);
    });
  }, [draft, mention]);

  // -- Voice input --
  const handleTranscript = useCallback((text: string, isFinal: boolean) => {
    if (isFinal) {
      setInterim("");
      setDraft((d) => (d ? d + " " : "") + text.trim());
    } else {
      setInterim(text);
    }
  }, []);

  // -- File attach --
  const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
  const onPickFile = () => fileRef.current?.click();
  const onFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    e.target.value = "";
    if (!f) return;
    if (f.size > MAX_UPLOAD_BYTES) {
      toast("error", `File too large (${(f.size / 1024 / 1024).toFixed(1)} MB) — max 25 MB`);
      return;
    }
    setUploading(true);
    setUploadProgress({ name: f.name, pct: 0 });
    try {
      const [r, dims] = await Promise.all([
        api.uploadFileWithProgress(sessionId, f, (p) =>
          setUploadProgress({ name: f.name, pct: Math.round(p * 100) }),
        ),
        readImageDimensions(f),
      ]);
      setAttachments((prev) => [
        ...prev,
        {
          name: r.name,
          path: r.path,
          size: r.size,
          isImage: !!dims || IMG_EXT.test(r.name),
          width: dims?.w,
          height: dims?.h,
        },
      ]);
      toast("success", `Attached ${r.name}`);
    } catch (err) {
      toast("error", (err as Error).message);
    } finally {
      setUploading(false);
      setUploadProgress(null);
    }
  };

  const removeAttachment = (path: string) => {
    setAttachments((prev) => prev.filter((a) => a.path !== path));
  };

  // -- Submit --
  const submit = useCallback(async () => {
    // The textarea ref is the authoritative source: when an IME
    // composition (e.g. Vietnamese Telex/VNI) commits as part of the
    // click → blur sequence, the resulting `onChange` schedules a
    // setDraft that hasn't applied yet by the time the form submit
    // handler runs. Reading state-only would drop the last-typed
    // syllable and only flush it on the *next* send. The DOM value
    // already includes draft + interim because that's what we feed
    // into `value={composedMessage}`.
    const live = (taRef.current?.value ?? (draft + (interim ? (draft ? " " : "") + interim : ""))).trim();
    if ((!live && attachments.length === 0) || sending) return;
    setSending(true);
    try {
      const attachLines = attachments
        .map((a) => `Attached file: \`${a.path}\` (${a.name}, ${a.size} bytes) — please Read it as part of this turn.`)
        .join("\n");
      const finalMsg = attachLines
        ? `${attachLines}\n\n${live}`.trim()
        : live;
      const res = await api.sendMessage(sessionId, { message: finalMsg, repo, settings });
      lastSentRef.current = live;
      setDraft("");
      setAttachments([]);
      setInterim("");
      if (res.queued) {
        // Server queued behind an in-flight turn — surface the
        // position so the user understands their message hasn't been
        // dropped, just held until the current turn finishes.
        setQueuedCount(res.position ?? (queuedCount + 1));
        toast(
          "info",
          res.position && res.position > 1
            ? `Queued (#${res.position}) — will send when current turn finishes`
            : "Queued — will send when current turn finishes",
        );
      }
      onSent?.();
    } catch (err) {
      toast("error", (err as Error).message);
    } finally {
      setSending(false);
    }
  }, [draft, interim, attachments, sending, sessionId, repo, settings, onSent, toast]);

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (mention) return; // MentionPicker handles ↑↓↵Esc
    if (
      e.key === "/" &&
      !e.shiftKey &&
      !slashPaletteOpen &&
      !e.altKey &&
      !e.ctrlKey &&
      !e.metaKey
    ) {
      const ta = taRef.current;
      if (!ta) return;
      const caret = ta.selectionStart ?? draft.length;
      const selEnd = ta.selectionEnd ?? draft.length;
      if (caret !== selEnd) return;
      const before = draft.slice(0, caret);
      if (isCaretAtLogicalLineStart(before)) {
        e.preventDefault();
        setSlashPaletteMountKey((k) => k + 1);
        setSlashPaletteOpen(true);
      }
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
      return;
    }
    if (e.key === "ArrowUp" && !draft && lastSentRef.current) {
      e.preventDefault();
      setDraft(lastSentRef.current);
    }
  };

  // -- Actions menu wiring --
  const insertAtCaret = useCallback((text: string) => {
    setInterim("");
    const el = taRef.current;
    const caret = el?.selectionStart ?? draft.length;
    const before = draft.slice(0, caret);
    const after = draft.slice(caret);
    const next = before + text + after;
    setDraft(next);
    requestAnimationFrame(() => {
      const ta = taRef.current;
      if (!ta) return;
      ta.focus();
      const newCaret = before.length + text.length;
      ta.setSelectionRange(newCaret, newCaret);
    });
  }, [draft]);

  const handleMentionAction = useCallback(() => {
    const el = taRef.current;
    const caret = el?.selectionStart ?? draft.length;
    const before = draft.slice(0, caret);
    const insert = before && !/\s$/.test(before) ? " @" : "@";
    insertAtCaret(insert);
  }, [draft, insertAtCaret]);

  const composedMessage = draft + (interim ? (draft ? " " : "") + interim : "");
  const canSend = !!composedMessage.trim() || attachments.length > 0;

  // Focus state lifts the composer's outer ring so the user sees a
  // single bordered "card" instead of two stacked rectangles
  // (textarea border + form border-t). When focused we also dim the
  // top border so the card visually merges with the chat above.
  const [focused, setFocused] = useState(false);

  const onSlashPaletteOpenChange = useCallback((open: boolean) => {
    setSlashPaletteOpen(open);
    if (!open) {
      requestAnimationFrame(() => taRef.current?.focus());
    }
  }, []);

  return (
    <form
      onSubmit={(e) => { e.preventDefault(); submit(); }}
      className="px-2 pt-1.5 pb-2 relative bg-card"
    >
      <input
        ref={fileRef}
        type="file"
        className="hidden"
        onChange={onFileChange}
      />

      {/* In-flight upload progress strip — surfaces percent + name so the
          user knows the file is going up, not silently lost. */}
      {uploadProgress && (
        <div className="mb-2 rounded-md border border-border bg-secondary px-2 py-1.5">
          <div className="flex items-center gap-1.5 text-[10.5px] text-muted-foreground mb-1">
            <Loader2 size={11} className="animate-spin text-primary" />
            <span className="font-medium truncate flex-1 min-w-0">{uploadProgress.name}</span>
            <span className="tabular-nums shrink-0">{uploadProgress.pct}%</span>
          </div>
          <div className="h-1 rounded-full overflow-hidden bg-background">
            <div
              className="h-full bg-primary transition-[width] duration-150"
              style={{ width: `${uploadProgress.pct}%` }}
            />
          </div>
        </div>
      )}

      {/* Composer card: textarea + chips + action row live inside one
          rounded surface so the composer reads as a single control,
          not three stacked widgets. Border lifts on focus. */}
      <div
        className={`relative rounded-xl border bg-background transition-colors overflow-visible ${
          focused
            ? "border-primary/60 shadow-[0_0_0_3px_rgba(106,168,255,0.12)]"
            : "border-border"
        }`}
      >
        {/* Attachment chips inside the card — image dimensions inline,
            like Claude's composer. */}
        {attachments.length > 0 && (
          <ul className="flex flex-wrap gap-1.5 px-2 pt-2">
            {attachments.map((a) => (
              <li
                key={a.path}
                className="group inline-flex items-center gap-1.5 pl-1.5 pr-1 py-0.5 rounded-md bg-secondary border border-border text-[10.5px]"
              >
                {a.isImage ? (
                  <ImageIcon size={11} className="text-success" />
                ) : (
                  <FileText size={11} className="text-muted-foreground" />
                )}
                <span className="font-medium truncate max-w-[180px]">{a.name}</span>
                {a.isImage && a.width && a.height ? (
                  <span className="text-muted-foreground tabular-nums">
                    {a.width}×{a.height}
                  </span>
                ) : (
                  <span className="text-muted-foreground tabular-nums">
                    {(a.size / 1024).toFixed(1)} KB
                  </span>
                )}
                <button
                  type="button"
                  onClick={() => removeAttachment(a.path)}
                  className="text-muted-foreground hover:text-destructive p-0.5 rounded"
                  aria-label="Remove attachment"
                >
                  <X size={10} />
                </button>
              </li>
            ))}
          </ul>
        )}

        {/* Textarea with mic anchored at top-right corner, Claude-style. */}
        <div className="relative">
          <textarea
            ref={taRef}
            value={composedMessage}
            onChange={(e) => {
              // During an IME composition (CJK input methods, accented
              // dead keys, etc.) `onChange` fires per syllable while the
              // candidate is still being chosen. Clearing `interim` and
              // setting the draft mid-composition drops the in-flight
              // syllable; defer until composition end.
              const native = e.nativeEvent as InputEvent & { isComposing?: boolean };
              if (native.isComposing) return;
              setInterim("");
              setDraft(e.target.value);
            }}
            onCompositionEnd={(e) => {
              setInterim("");
              setDraft((e.target as HTMLTextAreaElement).value);
            }}
            onKeyDown={onKeyDown}
            onSelect={detectMention}
            onClick={detectMention}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            placeholder={
              sending
                ? "Queue another message…"
                : `Message ${role}${repo ? ` @ ${repo}` : ""}…`
            }
            rows={1}
            className={`w-full bg-transparent border-0 rounded-t-xl pl-3 pr-9 pt-2.5 pb-1 text-[13px] resize-none focus:outline-none leading-relaxed placeholder:text-muted-foreground/70 overflow-y-hidden ${
              interim ? "italic text-muted-foreground" : ""
            }`}
            style={{ minHeight: `${MIN_H}px`, maxHeight: `${MAX_H}px` }}
          />
          <div className="absolute right-1.5 top-1.5">
            <MicButton onTranscript={handleTranscript} />
          </div>
        </div>

        {/* Action row inside the card so the whole control reads as one
            surface. Subtle top divider only when content above is
            non-trivial (textarea always is). */}
        <div className="flex items-center gap-1.5 px-1.5 pb-1.5 pt-1">
          <QuickAddMenu
            onAttach={onPickFile}
            onMention={handleMentionAction}
          />
          <SlashActionsPalette
            key={slashPaletteMountKey}
            open={slashPaletteOpen}
            onOpenChange={onSlashPaletteOpenChange}
            repo={repo}
            onSlashInsert={insertAtCaret}
            onAttach={onPickFile}
            onMention={handleMentionAction}
            onClear={onClearConversation}
            onRewind={onRewindRequest}
          />
          {uploading && <Loader2 size={12} className="text-muted-foreground animate-spin" />}

          {/* Hint sits between the action menus and the send button on
              wider viewports; hidden on mobile to keep the row tidy. */}
          <span
            className="hidden sm:inline text-[10px] text-muted-foreground/60 ml-1 truncate"
            aria-hidden="true"
          >
            Enter to send · Shift+Enter newline · @ mention · / commands
          </span>

          {/* Mode pill + Send live on the right edge, like Claude.
              Send takes priority over Stop the moment the user has
              anything to send — even while the agent is mid-response,
              so the queued-message workflow ("Queue another message…"
              placeholder) is reachable. Stop only surfaces when the
              draft is empty AND something is in flight, which is the
              only time the user genuinely has no other action. */}
          <div className="ml-auto flex items-center gap-1.5 shrink-0">
            {queuedCount > 0 && (
              <span
                className="inline-flex items-center h-5 px-1.5 rounded-md bg-secondary text-[10px] text-muted-foreground tabular-nums border border-border"
                title={`${queuedCount} message${queuedCount === 1 ? "" : "s"} queued — will send when current turn finishes`}
              >
                {queuedCount} queued
              </span>
            )}
            <ChatSettingsMenu value={settings} onChange={setSettings} />
            {canSend || !isResponding ? (
              <button
                type="submit"
                disabled={!canSend || sending}
                className="inline-flex items-center justify-center h-8 w-8 rounded-lg bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-40 disabled:cursor-not-allowed shrink-0 transition-colors"
                title={
                  sending
                    ? "Sending…"
                    : isResponding
                      ? "Queue message (Enter)"
                      : "Send (Enter)"
                }
                aria-label={isResponding ? "Queue message" : "Send"}
              >
                {sending ? <Loader2 size={13} className="animate-spin" /> : <Send size={13} />}
              </button>
            ) : (
              <button
                type="button"
                onClick={handleStop}
                disabled={stopping}
                className="inline-flex items-center justify-center h-8 w-8 rounded-lg bg-destructive text-destructive-foreground hover:bg-destructive/90 disabled:opacity-40 disabled:cursor-not-allowed shrink-0 transition-colors"
                title={stopping ? "Stopping…" : "Stop response"}
                aria-label="Stop"
              >
                {stopping ? <Loader2 size={13} className="animate-spin" /> : <Square size={13} fill="currentColor" />}
              </button>
            )}
          </div>
        </div>
      </div>

      {mention && repo && (
        <MentionPicker
          repo={repo}
          query={mention.query}
          onPick={insertMention}
          onClose={() => setMention(null)}
        />
      )}
    </form>
  );
}

// Outer wrapper keys the inner by `sessionId` so switching to a
// different session naturally remounts the composer — clearing the
// draft / attachments / mention / interim state without an effect
// that calls setState on prop change (which the React 19 hooks rule
// rejects for legitimate reasons: it's a recipe for cascading
// renders when the component happens to render twice for unrelated
// reasons).
function MessageComposerOuter(
  props: React.ComponentProps<typeof MessageComposerInner>,
) {
  return <MessageComposerInner key={props.sessionId} {...props} />;
}
export const MessageComposer = memo(MessageComposerOuter);
