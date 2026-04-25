"use client";

import { memo, useCallback, useEffect, useRef, useState } from "react";
import { Send, Loader2, Square, Image as ImageIcon, FileText, X } from "lucide-react";
import { api } from "@/lib/client/api";
import { useToast } from "./Toasts";
import { ChatSettingsMenu } from "./ChatSettingsMenu";
import { ActionsMenu, type ActionId } from "./ActionsMenu";
import { MentionPicker, type MentionMatch } from "./MentionPicker";
import { MicButton } from "./MicButton";
import type { ChatSettings } from "@/lib/client/types";

const MIN_H = 34;
const MAX_H = 220;
const STORAGE_KEY = "bridge.chat.settings";

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

function loadSettings(): ChatSettings {
  if (typeof window === "undefined") return {};
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as ChatSettings) : {};
  } catch { return {}; }
}

function saveSettings(s: ChatSettings) {
  if (typeof window === "undefined") return;
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(s)); } catch { /* quota */ }
}

function MessageComposerInner({
  sessionId,
  repo,
  repoPath,
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
  // Settings start blank on the server and rehydrate from localStorage
  // *after* mount — reading localStorage in the initial state would
  // render different icons on server vs client (hydration mismatch).
  const [settings, setSettingsState] = useState<ChatSettings>({});
  useEffect(() => { setSettingsState(loadSettings()); }, []);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [uploading, setUploading] = useState(false);
  const [mention, setMention] = useState<{ start: number; query: string } | null>(null);
  const [interim, setInterim] = useState("");
  const lastSentRef = useRef<string>("");
  const taRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const toast = useToast();

  const setSettings = useCallback((next: ChatSettings) => {
    setSettingsState(next);
    saveSettings(next);
  }, []);

  // Stop the in-flight claude subprocess for this session. 404 ("no
  // live process") is benign — the run finished a moment ago and the
  // registry already cleaned up. Anything else is surfaced as a toast.
  const handleStop = useCallback(async () => {
    if (stopping) return;
    setStopping(true);
    try {
      await api.killSession(sessionId);
    } catch (err) {
      const msg = (err as Error).message;
      if (!msg.includes("404")) toast("error", msg);
    } finally {
      setStopping(false);
    }
  }, [sessionId, stopping, toast]);

  useEffect(() => {
    setDraft("");
    setAttachments([]);
    setMention(null);
    setInterim("");
  }, [sessionId]);

  const resize = useCallback(() => {
    const el = taRef.current;
    if (!el) return;
    el.style.height = "0px";
    const h = Math.min(MAX_H, Math.max(MIN_H, el.scrollHeight));
    el.style.height = `${h}px`;
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
  const onPickFile = () => fileRef.current?.click();
  const onFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    e.target.value = "";
    if (!f) return;
    setUploading(true);
    try {
      const [r, dims] = await Promise.all([
        api.uploadFile(sessionId, f),
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
    }
  };

  const removeAttachment = (path: string) => {
    setAttachments((prev) => prev.filter((a) => a.path !== path));
  };

  // -- Submit --
  const submit = useCallback(async () => {
    const msg = (draft + (interim ? " " + interim : "")).trim();
    if ((!msg && attachments.length === 0) || sending) return;
    setSending(true);
    try {
      const attachLines = attachments
        .map((a) => `Attached file: \`${a.path}\` (${a.name}, ${a.size} bytes) — please Read it as part of this turn.`)
        .join("\n");
      const finalMsg = attachLines
        ? `${attachLines}\n\n${msg}`.trim()
        : msg;
      await api.sendMessage(sessionId, { message: finalMsg, repo, settings });
      lastSentRef.current = msg;
      setDraft("");
      setAttachments([]);
      setInterim("");
      onSent?.();
    } catch (err) {
      toast("error", (err as Error).message);
    } finally {
      setSending(false);
    }
  }, [draft, interim, attachments, sending, sessionId, repo, settings, onSent, toast]);

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (mention) return; // MentionPicker handles ↑↓↵Esc
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
  const onActionPick = (id: ActionId) => {
    if (id === "attach") { onPickFile(); return; }
    if (id === "mention") {
      const el = taRef.current;
      if (!el) return;
      const caret = el.selectionStart ?? draft.length;
      const before = draft.slice(0, caret);
      const after = draft.slice(caret);
      const insert = before && !/\s$/.test(before) ? " @" : "@";
      const next = before + insert + after;
      setDraft(next);
      requestAnimationFrame(() => {
        el.focus();
        const newCaret = before.length + insert.length;
        el.setSelectionRange(newCaret, newCaret);
      });
      return;
    }
    if (id === "clear") {
      if (!onClearConversation) {
        toast("info", "Open this from inside a task to clear its conversation");
        return;
      }
      onClearConversation();
      return;
    }
    if (id === "rewind") {
      if (!onRewindRequest) {
        toast("info", "Click on a user message in the log, then choose Rewind");
        return;
      }
      onRewindRequest();
      return;
    }
    if (id === "switch-model" || id === "effort" || id === "thinking") {
      toast("info", "Open the Mode picker (button to the left of Send)");
      return;
    }
    if (id === "account") {
      window.open("https://console.anthropic.com/settings/usage", "_blank", "noopener");
      return;
    }
  };

  const composedMessage = draft + (interim ? (draft ? " " : "") + interim : "");
  const canSend = !!composedMessage.trim() || attachments.length > 0;

  return (
    <form
      onSubmit={(e) => { e.preventDefault(); submit(); }}
      className="border-t border-border p-2 relative"
    >
      <input
        ref={fileRef}
        type="file"
        className="hidden"
        onChange={onFileChange}
      />

      {/* Attachment chips above the textarea — image dimensions inline,
          like Claude's composer. */}
      {attachments.length > 0 && (
        <ul className="flex flex-wrap gap-1.5 mb-2">
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
          onChange={(e) => { setInterim(""); setDraft(e.target.value); }}
          onKeyDown={onKeyDown}
          onSelect={detectMention}
          onClick={detectMention}
          placeholder={
            sending
              ? "Queue another message…"
              : `Message ${role}${repo ? ` @ ${repo}` : ""}…  (Enter send · Shift+Enter newline · @ mention)`
          }
          rows={1}
          className={`w-full bg-background border border-border rounded-md pl-3 pr-9 py-1.5 text-xs resize-none focus:outline-none focus:border-primary leading-snug ${
            interim ? "italic text-muted-foreground" : ""
          }`}
          style={{ minHeight: `${MIN_H}px`, maxHeight: `${MAX_H}px` }}
        />
        <div className="absolute right-1.5 top-1.5">
          <MicButton onTranscript={handleTranscript} />
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

      <div className="flex items-center gap-1.5 mt-2">
        <ActionsMenu
          onPick={onActionPick}
          disabled={{
            clear: !onClearConversation,
            rewind: !onRewindRequest,
          }}
        />
        {uploading && <Loader2 size={12} className="text-muted-foreground animate-spin" />}

        {/* Mode pill + Send live on the right edge, like Claude. */}
        <div className="ml-auto flex items-center gap-1.5 shrink-0">
          <ChatSettingsMenu value={settings} onChange={setSettings} />
          {isResponding ? (
            <button
              type="button"
              onClick={handleStop}
              disabled={stopping}
              className="inline-flex items-center justify-center h-7 w-7 rounded-md bg-destructive text-destructive-foreground hover:bg-destructive/90 disabled:opacity-40 disabled:cursor-not-allowed shrink-0"
              title={stopping ? "Stopping…" : "Stop response"}
              aria-label="Stop"
            >
              {stopping ? <Loader2 size={12} className="animate-spin" /> : <Square size={12} fill="currentColor" />}
            </button>
          ) : (
            <button
              type="submit"
              disabled={!canSend || sending}
              className="inline-flex items-center justify-center h-7 w-7 rounded-md bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-40 disabled:cursor-not-allowed shrink-0"
              title={sending ? "Sending…" : "Send (Enter)"}
              aria-label="Send"
            >
              {sending ? <Loader2 size={12} className="animate-spin" /> : <Send size={12} />}
            </button>
          )}
        </div>
      </div>
    </form>
  );
}

export const MessageComposer = memo(MessageComposerInner);
