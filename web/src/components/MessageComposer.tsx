import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  Send,
  Loader2,
  Square,
  Image as ImageIcon,
  FileText,
  X,
  Mic,
} from "lucide-react";
import { api } from "@/api/client";
import { useToast } from "@/components/Toasts";
import { ChatSettingsMenu } from "@/components/ChatSettingsMenu";
import { QuickAddMenu } from "@/components/QuickAddMenu";
import { SlashActionsPalette } from "@/components/SlashActionsPalette";
import {
  MentionPicker,
  type MentionMatch,
} from "@/components/MentionPicker";
import type { ChatSettings } from "@/api/types";
import { cn } from "@/lib/cn";

const MIN_H = 34;
const MAX_H = 220;
const STORAGE_KEY = "bridge.chat.settings";
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
const IMG_EXT = /\.(png|jpe?g|gif|webp|svg|bmp|avif)$/i;

// Operator opt-in: when `VITE_BRIDGE_ALLOW_BYPASS=1` is set, treat
// "Skip permissions" as the implicit default for any session that has
// not yet picked a mode. Otherwise a brand-new task starts in `default`
// (Ask-before-edits). Explicit picks still win — the loader only fills
// in the mode when the stored object has none.
const COMPOSER_DEFAULT_MODE: "bypassPermissions" | undefined =
  import.meta.env.VITE_BRIDGE_ALLOW_BYPASS === "1" ? "bypassPermissions" : undefined;
const EMPTY_SETTINGS: ChatSettings = COMPOSER_DEFAULT_MODE
  ? { mode: COMPOSER_DEFAULT_MODE }
  : {};

interface Attachment {
  name: string;
  path: string;
  size: number;
  isImage: boolean;
  /** Pixel dimensions for images, populated client-side after upload. */
  width?: number;
  height?: number;
}

/**
 * Read pixel dimensions from a File without uploading. Returns null
 * for non-images or unreadable files.
 */
function readImageDimensions(
  file: File,
): Promise<{ w: number; h: number } | null> {
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

function readSettings(key: string): ChatSettings {
  try {
    const raw = localStorage.getItem(key);
    if (raw) {
      const parsed = JSON.parse(raw) as ChatSettings;
      // Apply env-based default mode if the loaded object has none yet.
      if (parsed.mode === undefined && COMPOSER_DEFAULT_MODE) {
        return { ...parsed, mode: COMPOSER_DEFAULT_MODE };
      }
      return parsed;
    }
    // No per-task settings yet — fall back to the global key so existing
    // prefs carry over to a brand-new task on first render.
    if (key !== STORAGE_KEY) {
      const fallback = localStorage.getItem(STORAGE_KEY);
      if (fallback) {
        const parsed = JSON.parse(fallback) as ChatSettings;
        if (parsed.mode === undefined && COMPOSER_DEFAULT_MODE) {
          return { ...parsed, mode: COMPOSER_DEFAULT_MODE };
        }
        return parsed;
      }
    }
    return EMPTY_SETTINGS;
  } catch {
    return EMPTY_SETTINGS;
  }
}

function writeSettings(key: string, s: ChatSettings) {
  try {
    localStorage.setItem(key, JSON.stringify(s));
  } catch {
    /* private mode etc. — no-op */
  }
}

export interface MessageComposerProps {
  sessionId: string;
  repo: string;
  /** Display label in the placeholder ("Message {role} @ {repo}…"). */
  role?: string;
  /**
   * When set, chat settings persist under a per-task localStorage key
   * (`bridge.chat.settings.task.<taskId>`) so a heavy `effort: max`
   * override doesn't bleed into sibling tasks. Free-form Sessions page
   * omits this prop and reads/writes the global key.
   */
  taskId?: string;
  /** Streaming flag — when true the Send button morphs into Stop. */
  isResponding?: boolean;
  /**
   * Send handler. Receives the composed message + the chat settings
   * picked by the operator. Returning a promise blocks the composer
   * with a loading state.
   */
  onSend?: (message: string, settings: ChatSettings) => Promise<void> | void;
  /** Stop handler. Wired to the Stop button while `isResponding`. */
  onStop?: () => Promise<void> | void;
  /** Optional slot — fired after a successful send. */
  onSent?: () => void;
}

/**
 * Inner body — keyed by `sessionId` from the wrapper so switching
 * sessions naturally remounts (resets draft / attachments / mention
 * state) without an effect-driven setState pair.
 */
function MessageComposerInner({
  sessionId,
  repo,
  role = "claude",
  taskId,
  isResponding = false,
  onSend,
  onStop,
  onSent,
}: MessageComposerProps) {
  const storageKey = useMemo(() => settingsKey(taskId), [taskId]);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [settings, setSettings] = useState<ChatSettings>(() =>
    readSettings(storageKey),
  );
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [uploading, setUploading] = useState(false);
  const [uploadPct, setUploadPct] = useState<{
    name: string;
    pct: number;
  } | null>(null);
  const [mention, setMention] = useState<{ start: number; query: string } | null>(
    null,
  );
  const [slashOpen, setSlashOpen] = useState(false);
  const [slashQuery, setSlashQuery] = useState("");
  const [focused, setFocused] = useState(false);

  const lastSentRef = useRef<string>("");
  const taRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const toast = useToast();

  // Persist settings on every change.
  useEffect(() => {
    writeSettings(storageKey, settings);
  }, [storageKey, settings]);

  // ── Auto-resize ────────────────────────────────────────────────────
  const resize = useCallback(() => {
    const el = taRef.current;
    if (!el) return;
    el.style.height = "0px";
    const natural = el.scrollHeight;
    const h = Math.min(MAX_H, Math.max(MIN_H, natural));
    el.style.height = `${h}px`;
    el.style.overflowY = natural > MAX_H ? "auto" : "hidden";
  }, []);
  useEffect(resize, [draft, resize]);

  // ── Mention detection ──────────────────────────────────────────────
  const detectMention = useCallback(() => {
    const el = taRef.current;
    if (!el) return;
    const caret = el.selectionStart ?? 0;
    const upTo = draft.slice(0, caret);
    const at = upTo.lastIndexOf("@");
    if (at < 0) {
      setMention(null);
      return;
    }
    const prev = at === 0 ? " " : upTo[at - 1];
    if (!/\s/.test(prev)) {
      setMention(null);
      return;
    }
    const after = upTo.slice(at + 1);
    if (/\s/.test(after)) {
      setMention(null);
      return;
    }
    setMention({ start: at, query: after });
  }, [draft]);

  useEffect(() => {
    detectMention();
  }, [draft, detectMention]);

  const insertMention = useCallback(
    (m: MentionMatch) => {
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
    },
    [draft, mention],
  );

  // ── Slash detection ────────────────────────────────────────────────
  // Open the slash palette when the user types `/` at the start of an
  // empty line or as the very first char. Track the substring after `/`
  // to feed the palette filter.
  useEffect(() => {
    if (!slashOpen) return;
    const el = taRef.current;
    if (!el) return;
    const caret = el.selectionStart ?? draft.length;
    const upTo = draft.slice(0, caret);
    const lineStart = upTo.lastIndexOf("\n") + 1;
    const slashAt = upTo.indexOf("/", lineStart);
    if (slashAt < lineStart || slashAt < 0) {
      setSlashOpen(false);
      return;
    }
    setSlashQuery(upTo.slice(slashAt + 1));
  }, [draft, slashOpen]);

  const insertAtCaret = useCallback(
    (text: string) => {
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
    },
    [draft],
  );

  // When the slash palette inserts a command, replace the in-progress
  // `/<filter>` token rather than appending after it.
  const onSlashPick = useCallback(
    (text: string) => {
      const el = taRef.current;
      const caret = el?.selectionStart ?? draft.length;
      const upTo = draft.slice(0, caret);
      const lineStart = upTo.lastIndexOf("\n") + 1;
      const slashAt = upTo.indexOf("/", lineStart);
      if (slashAt < 0) {
        insertAtCaret(text);
        return;
      }
      const before = draft.slice(0, slashAt);
      const after = draft.slice(caret);
      const next = before + text + after;
      setDraft(next);
      requestAnimationFrame(() => {
        const ta = taRef.current;
        if (!ta) return;
        ta.focus();
        const c = before.length + text.length;
        ta.setSelectionRange(c, c);
      });
    },
    [draft, insertAtCaret],
  );

  // ── Stop ───────────────────────────────────────────────────────────
  const handleStop = useCallback(async () => {
    if (stopping) return;
    setStopping(true);
    try {
      if (onStop) {
        await onStop();
      } else {
        await api.sessions.kill(sessionId);
      }
    } catch (err) {
      const msg = (err as Error).message;
      if (!msg.includes("404")) toast.error(msg);
    } finally {
      setStopping(false);
    }
  }, [sessionId, stopping, onStop, toast]);

  // ── File handling ──────────────────────────────────────────────────
  const onPickFile = () => fileRef.current?.click();

  const uploadOne = useCallback(
    async (f: File) => {
      if (f.size > MAX_UPLOAD_BYTES) {
        toast.error(
          `File too large (${(f.size / 1024 / 1024).toFixed(1)} MB) — max 25 MB`,
        );
        return;
      }
      setUploading(true);
      setUploadPct({ name: f.name, pct: 0 });
      try {
        const [r, dims] = await Promise.all([
          api.uploads.withProgress(sessionId, f, (p) =>
            setUploadPct({ name: f.name, pct: Math.round(p * 100) }),
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
        toast.success(`Attached ${r.name}`);
      } catch (err) {
        toast.error((err as Error).message);
      } finally {
        setUploading(false);
        setUploadPct(null);
      }
    },
    [sessionId, toast],
  );

  const onFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    e.target.value = "";
    if (!f) return;
    await uploadOne(f);
  };

  const removeAttachment = (path: string) => {
    setAttachments((prev) => prev.filter((a) => a.path !== path));
  };

  // ── Drag-and-drop ──────────────────────────────────────────────────
  const [dragOver, setDragOver] = useState(false);
  const onDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const f = e.dataTransfer.files?.[0];
    if (f) await uploadOne(f);
  };

  // ── Submit ────────────────────────────────────────────────────────
  const composedMessage = draft;
  const canSend = !!composedMessage.trim() || attachments.length > 0;

  const submit = useCallback(async () => {
    const live = (taRef.current?.value ?? draft).trim();
    if ((!live && attachments.length === 0) || sending) return;
    setSending(true);
    try {
      const attachLines = attachments
        .map(
          (a) =>
            `Attached file: \`${a.path}\` (${a.name}, ${a.size} bytes) — please Read it as part of this turn.`,
        )
        .join("\n");
      const finalMsg = attachLines ? `${attachLines}\n\n${live}`.trim() : live;
      if (onSend) {
        await onSend(finalMsg, settings);
      } else {
        await api.sessions.message(sessionId, {
          message: finalMsg,
          repo,
          settings,
        });
      }
      lastSentRef.current = live;
      setDraft("");
      setAttachments([]);
      onSent?.();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setSending(false);
    }
  }, [
    draft,
    attachments,
    sending,
    sessionId,
    repo,
    settings,
    onSend,
    onSent,
    toast,
  ]);

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (mention) return; // MentionPicker owns ↑↓↵Esc.
    if (slashOpen) return; // SlashActionsPalette owns ↑↓↵Esc.

    if (
      e.key === "/" &&
      !e.shiftKey &&
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
      const ls = before.lastIndexOf("\n") + 1;
      if (before.slice(ls).trim() === "") {
        // Allow the keystroke to insert "/" — palette's filter then
        // sees an empty query. Setting slashOpen synchronously means
        // the next render shows the popover.
        setSlashOpen(true);
        setSlashQuery("");
        return;
      }
    }

    // Cmd/Ctrl+Enter or plain Enter (without Shift) submits.
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void submit();
      return;
    }

    if (e.key === "ArrowUp" && !draft && lastSentRef.current) {
      e.preventDefault();
      setDraft(lastSentRef.current);
    }
  };

  const placeholder = useMemo(
    () =>
      sending
        ? "Queue another message…"
        : `Message ${role}${repo ? ` @ ${repo}` : ""}…`,
    [sending, role, repo],
  );

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
      className="px-2 pt-1.5 pb-2 relative bg-card"
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes("Files")) {
          e.preventDefault();
          setDragOver(true);
        }
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => void onDrop(e)}
    >
      <input
        ref={fileRef}
        type="file"
        className="hidden"
        onChange={(e) => void onFileChange(e)}
      />

      {uploadPct && (
        <div className="mb-2 rounded-sm border border-border bg-secondary px-2 py-1.5">
          <div className="flex items-center gap-1.5 text-[10.5px] text-muted-foreground mb-1">
            <Loader2 size={11} className="animate-spin text-primary" />
            <span className="font-medium truncate flex-1 min-w-0">
              {uploadPct.name}
            </span>
            <span className="tabular-nums shrink-0">{uploadPct.pct}%</span>
          </div>
          <div className="h-1 rounded-full overflow-hidden bg-background">
            <div
              className="h-full bg-primary transition-[width] duration-150"
              style={{ width: `${uploadPct.pct}%` }}
            />
          </div>
        </div>
      )}

      <div
        className={cn(
          "relative rounded-md border bg-background transition-colors overflow-visible",
          focused
            ? "border-primary/60 ring-2 ring-primary/20"
            : dragOver
              ? "border-primary border-dashed"
              : "border-border",
        )}
      >
        {attachments.length > 0 && (
          <ul className="flex flex-wrap gap-1.5 px-2 pt-2">
            {attachments.map((a) => (
              <li
                key={a.path}
                className="group inline-flex items-center gap-1.5 pl-1.5 pr-1 py-0.5 rounded-sm bg-secondary border border-border text-[10.5px]"
              >
                {a.isImage ? (
                  <ImageIcon size={11} className="text-success" />
                ) : (
                  <FileText size={11} className="text-muted-foreground" />
                )}
                <span className="font-medium truncate max-w-[180px]">
                  {a.name}
                </span>
                <span className="text-muted-foreground tabular-nums">
                  {(a.size / 1024).toFixed(1)} KB
                </span>
                <button
                  type="button"
                  onClick={() => removeAttachment(a.path)}
                  className="text-muted-foreground hover:text-destructive p-0.5 rounded-sm"
                  aria-label="Remove attachment"
                >
                  <X size={10} />
                </button>
              </li>
            ))}
          </ul>
        )}

        <div className="relative">
          <textarea
            ref={taRef}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={onKeyDown}
            onSelect={detectMention}
            onClick={detectMention}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            placeholder={placeholder}
            rows={1}
            className="w-full bg-transparent border-0 rounded-t-md pl-3 pr-9 pt-2.5 pb-1 text-[13px] resize-none focus:outline-none leading-relaxed placeholder:text-muted-foreground overflow-y-hidden"
            style={{ minHeight: `${MIN_H}px`, maxHeight: `${MAX_H}px` }}
          />
          {/* MicButton placeholder — voice input deferred. */}
          <button
            type="button"
            disabled
            title="Voice input not available in this build"
            aria-label="Voice input (disabled)"
            className="absolute right-1.5 top-1.5 inline-flex items-center justify-center h-6 w-6 rounded-sm text-muted-foreground/50 cursor-not-allowed"
          >
            <Mic size={12} />
          </button>
        </div>

        <div className="flex items-center gap-1.5 px-1.5 pb-1.5 pt-1">
          <QuickAddMenu
            onAttach={onPickFile}
            onMention={() => insertAtCaret("@")}
          />
          {uploading && (
            <Loader2 size={12} className="text-muted-foreground animate-spin" />
          )}

          <span
            className="hidden sm:inline text-[10px] text-muted-foreground ml-1 truncate"
            aria-hidden="true"
          >
            Enter to send · Shift+Enter newline · @ mention · / commands
          </span>

          <div className="ml-auto flex items-center gap-1.5 shrink-0">
            <ChatSettingsMenu value={settings} onChange={setSettings} />
            {isResponding ? (
              <button
                type="button"
                onClick={() => void handleStop()}
                disabled={stopping}
                className="inline-flex items-center justify-center h-8 w-8 rounded-md bg-destructive text-destructive-foreground hover:bg-destructive/90 disabled:opacity-40 disabled:cursor-not-allowed shrink-0 transition-colors"
                title={stopping ? "Stopping…" : "Stop response"}
                aria-label="Stop"
              >
                {stopping ? (
                  <Loader2 size={13} className="animate-spin" />
                ) : (
                  <Square size={13} fill="currentColor" />
                )}
              </button>
            ) : (
              <button
                type="submit"
                disabled={!canSend || sending}
                className="inline-flex items-center justify-center h-8 w-8 rounded-md bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-40 disabled:cursor-not-allowed shrink-0 transition-colors"
                title={sending ? "Sending…" : "Send (Enter)"}
                aria-label="Send"
              >
                {sending ? (
                  <Loader2 size={13} className="animate-spin" />
                ) : (
                  <Send size={13} />
                )}
              </button>
            )}
          </div>
        </div>

        {/* Slash palette mounts inside the rounded card so the popover
            anchors visually to the textarea. */}
        <SlashActionsPalette
          open={slashOpen}
          onOpenChange={setSlashOpen}
          repo={repo}
          query={slashQuery}
          onPick={onSlashPick}
        />
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

/**
 * Outer wrapper keys the inner by `sessionId` so switching sessions
 * naturally remounts the composer — clearing draft / attachments /
 * mention state without an effect-driven setState pair.
 */
function MessageComposerOuter(props: MessageComposerProps) {
  return <MessageComposerInner key={props.sessionId} {...props} />;
}

export const MessageComposer = memo(MessageComposerOuter);
