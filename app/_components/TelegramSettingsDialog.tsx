"use client";

import { useEffect, useRef, useState } from "react";
import { Send } from "lucide-react";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { api } from "@/lib/client/api";
import { useToast } from "./Toasts";

interface TelegramSettingsDialogProps {
  open: boolean;
  onOpenChange(open: boolean): void;
}

/**
 * Edit Telegram notifier credentials. Persisted at
 * `~/.claude/bridge.json.telegram` (per-machine, outside the project
 * tree). Replaces the legacy `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID`
 * env vars — the UI here is the canonical source going forward.
 *
 * Bot token is masked on read so it never round-trips through the
 * browser DevTools / network log. The user types a new one to replace,
 * or leaves it blank to keep the existing value (the helper below
 * detects that case and omits `botToken` from the PATCH).
 */
export function TelegramSettingsDialog({
  open,
  onOpenChange,
}: TelegramSettingsDialogProps) {
  const [botToken, setBotToken] = useState("");
  const [chatId, setChatId] = useState("");
  const [maskedToken, setMaskedToken] = useState("");
  const [tokenAlreadySet, setTokenAlreadySet] = useState(false);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const tokenRef = useRef<HTMLInputElement>(null);
  const toast = useToast();

  // Refetch on open so a settings dialog opened minutes after page load
  // sees the latest persisted value (operator may have edited via API).
  // The fetch is wrapped in an async IIFE so the synchronous `setLoading`
  // happens from a callback (avoids the react-hooks/set-state-in-effect
  // lint rule firing on a sync setState in an effect body).
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void (async () => {
      setLoading(true);
      try {
        const s = await api.telegramSettings();
        if (cancelled) return;
        setBotToken("");
        setMaskedToken(s.botToken);
        setTokenAlreadySet(s.botTokenSet);
        setChatId(s.chatId);
      } catch (e) {
        if (!cancelled) toast("error", (e as Error).message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, toast]);

  useEffect(() => {
    if (open && !loading) {
      requestAnimationFrame(() => tokenRef.current?.focus());
    }
  }, [open, loading]);

  const submit = async () => {
    setSaving(true);
    try {
      // Empty token field = keep the existing one (don't blank it).
      // Empty chat id field = blank it (chat ids aren't sensitive
      // enough to need the same "leave blank to keep" UX).
      const patch: { botToken?: string; chatId?: string } = {
        chatId: chatId.trim(),
      };
      if (botToken.trim().length > 0) patch.botToken = botToken.trim();
      const next = await api.updateTelegramSettings(patch);
      setBotToken("");
      setMaskedToken(next.botToken);
      setTokenAlreadySet(next.botTokenSet);
      setChatId(next.chatId);
      toast("success", "Telegram settings saved");
      onOpenChange(false);
    } catch (e) {
      toast("error", (e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const sendTest = async () => {
    setTesting(true);
    try {
      const r = await api.telegramTest();
      if (r.ok) toast("success", "Telegram message sent");
      else toast("error", `Telegram: ${r.reason}`);
    } finally {
      setTesting(false);
    }
  };

  const clear = async () => {
    setSaving(true);
    try {
      const next = await api.updateTelegramSettings({ botToken: "", chatId: "" });
      setBotToken("");
      setMaskedToken(next.botToken);
      setTokenAlreadySet(next.botTokenSet);
      setChatId(next.chatId);
      toast("info", "Telegram settings cleared");
      onOpenChange(false);
    } catch (e) {
      toast("error", (e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Telegram notifier</DialogTitle>
          <DialogDescription>
            Saved to{" "}
            <code className="font-mono text-foreground">
              ~/.claude/bridge.json
            </code>{" "}
            under the <code className="font-mono">telegram</code> key. Empty
            both fields to disable. Get a bot token from{" "}
            <code className="font-mono">@BotFather</code> on Telegram, then
            call{" "}
            <code className="font-mono">
              api.telegram.org/bot&lt;TOKEN&gt;/getUpdates
            </code>{" "}
            to find your chat id.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 py-2">
          <div className="grid gap-1.5">
            <Label htmlFor="tg-token">Bot token</Label>
            <Input
              ref={tokenRef}
              id="tg-token"
              value={botToken}
              onChange={(e) => setBotToken(e.target.value)}
              placeholder={
                tokenAlreadySet
                  ? `${maskedToken} (leave blank to keep)`
                  : "123456789:ABCDEF…"
              }
              autoComplete="off"
              spellCheck={false}
              type="password"
            />
            <p className="text-[11px] text-muted-foreground">
              {tokenAlreadySet
                ? "A token is already saved. Type a new one to replace it."
                : "Sensitive — anyone with this token can post as your bot."}
            </p>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="tg-chat">Chat id</Label>
            <Input
              id="tg-chat"
              value={chatId}
              onChange={(e) => setChatId(e.target.value)}
              placeholder="-1001234567890 or 123456789"
              autoComplete="off"
              spellCheck={false}
            />
            <p className="text-[11px] text-muted-foreground">
              The numeric chat id where the bot should post.
            </p>
          </div>
        </div>
        <DialogFooter className="gap-2 sm:gap-2">
          <Button
            variant="ghost"
            onClick={sendTest}
            disabled={testing || saving || loading}
            title="Send a test message to verify the credentials"
          >
            <Send className="h-3.5 w-3.5" />
            {testing ? "Sending…" : "Send test"}
          </Button>
          <div className="flex-1" />
          <Button
            variant="ghost"
            onClick={clear}
            disabled={saving || loading || (!tokenAlreadySet && !chatId)}
            className="text-fg-dim hover:text-destructive"
          >
            Clear
          </Button>
          <Button
            variant="ghost"
            onClick={() => onOpenChange(false)}
            disabled={saving}
          >
            Cancel
          </Button>
          <Button
            onClick={submit}
            disabled={saving || loading}
            title="Save the credentials to bridge.json"
          >
            {saving ? "Saving…" : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
