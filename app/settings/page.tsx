"use client";

import { useEffect, useState } from "react";
import { Send, Settings as SettingsIcon, Sparkles } from "lucide-react";
import { api } from "@/lib/client/api";
import { HeaderShell } from "../_components/HeaderShell";
import { Button } from "../_components/ui/button";
import { Input } from "../_components/ui/input";
import { Label } from "../_components/ui/label";
import { useToast } from "../_components/Toasts";
import { ListSkeleton } from "../_components/ui/skeleton";

type DetectSource = "auto" | "llm" | "heuristic";

const DETECT_OPTIONS: { value: DetectSource; label: string; hint: string }[] = [
  {
    value: "auto",
    label: "Auto",
    hint: "Try LLM first, fall back to heuristic on error or when claude CLI is unavailable. Recommended.",
  },
  {
    value: "llm",
    label: "LLM only",
    hint: "Always call claude -p to detect scope. Falls back to heuristic with low confidence on error.",
  },
  {
    value: "heuristic",
    label: "Heuristic only",
    hint: "Pure local keyword matching. Fastest, deterministic, no API call.",
  },
];

/**
 * Bridge-wide settings page. Currently houses:
 *
 *   - **Telegram notifier** — bot token + chat id for the lifecycle
 *     event forwarder. Persists to `bridge.json.telegram`.
 *   - **Detection layer** — `auto`/`llm`/`heuristic` toggle that drives
 *     `lib/detect`. Persists to `bridge.json.detect.source`.
 *
 * Both sections write to the same `~/.claude/bridge.json` so the file
 * is the single source of truth for per-machine bridge configuration.
 */
function SettingsPage() {
  return (
    <div className="flex flex-col h-screen">
      <HeaderShell active="settings" />
      <main className="flex-1 overflow-y-auto">
        <div className="p-6 max-w-3xl mx-auto space-y-8">
          <div className="flex items-center gap-2 mb-2">
            <SettingsIcon size={18} className="text-primary" />
            <h2 className="text-lg font-semibold">Settings</h2>
          </div>
          <p className="text-xs text-muted-foreground -mt-4">
            Per-machine configuration stored in{" "}
            <code className="font-mono text-foreground">
              ~/.claude/bridge.json
            </code>
            . Outside the project tree so version updates can&apos;t overwrite
            your bot tokens / detection mode.
          </p>

          <DetectSettingsSection />
          <TelegramSettingsSection />
        </div>
      </main>
    </div>
  );
}

function DetectSettingsSection() {
  const [source, setSource] = useState<DetectSource>("auto");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const toast = useToast();

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const s = await api.detectSettings();
        if (!cancelled) setSource(s.source);
      } catch (e) {
        if (!cancelled) toast("error", (e as Error).message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [toast]);

  const choose = async (next: DetectSource) => {
    if (next === source) return;
    setSaving(true);
    try {
      const r = await api.updateDetectSettings({ source: next });
      setSource(r.source);
      toast("success", `Detection source: ${r.source}`);
    } catch (e) {
      toast("error", (e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="rounded-lg border border-border bg-card p-4">
      <div className="flex items-center gap-2 mb-1">
        <Sparkles size={14} className="text-primary" />
        <h3 className="text-sm font-semibold">Scope detection</h3>
      </div>
      <p className="text-[11px] text-muted-foreground mb-4">
        Controls how the bridge picks repo + features for a new task.
        Detection runs once at task-create time and is cached in{" "}
        <code className="font-mono">meta.json</code>; both coordinator and
        every spawned child read the same scope.
      </p>

      {loading ? (
        <ListSkeleton rows={3} />
      ) : (
        <div className="grid gap-2">
          {DETECT_OPTIONS.map((opt) => {
            const active = opt.value === source;
            return (
              <button
                key={opt.value}
                type="button"
                onClick={() => choose(opt.value)}
                disabled={saving}
                aria-pressed={active}
                className={`text-left rounded-md border p-3 transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${
                  active
                    ? "border-primary/40 bg-primary/5"
                    : "border-border hover:border-primary/30 hover:bg-accent/30"
                }`}
              >
                <div className="flex items-center gap-2">
                  <span
                    className={`inline-flex h-3.5 w-3.5 rounded-full border ${
                      active
                        ? "border-primary bg-primary"
                        : "border-border bg-transparent"
                    }`}
                    aria-hidden
                  />
                  <span className="text-sm font-medium">{opt.label}</span>
                  <span className="text-[10px] font-mono text-muted-foreground">
                    {opt.value}
                  </span>
                </div>
                <p className="mt-1 ml-5 text-[11px] text-muted-foreground">
                  {opt.hint}
                </p>
              </button>
            );
          })}
        </div>
      )}
    </section>
  );
}

function TelegramSettingsSection() {
  const [botToken, setBotToken] = useState("");
  const [chatId, setChatId] = useState("");
  const [maskedToken, setMaskedToken] = useState("");
  const [tokenAlreadySet, setTokenAlreadySet] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const toast = useToast();

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const s = await api.telegramSettings();
        if (cancelled) return;
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
  }, [toast]);

  const submit = async () => {
    setSaving(true);
    try {
      // Empty token field = keep the existing one (don't blank it).
      // Empty chat id field = blank it (chat ids aren't sensitive
      // enough to need the "leave blank to keep" UX).
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
    } catch (e) {
      toast("error", (e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="rounded-lg border border-border bg-card p-4">
      <div className="flex items-center gap-2 mb-1">
        <Send size={14} className="text-primary" />
        <h3 className="text-sm font-semibold">Telegram notifier</h3>
      </div>
      <p className="text-[11px] text-muted-foreground mb-4">
        Forwards run lifecycle events (done / failed) and pending permission
        requests to a Telegram chat. Empty both fields to disable. Get a bot
        token from <code className="font-mono">@BotFather</code> on Telegram,
        then call{" "}
        <code className="font-mono">
          api.telegram.org/bot&lt;TOKEN&gt;/getUpdates
        </code>{" "}
        to find your chat id.
      </p>

      {loading ? (
        <ListSkeleton rows={2} />
      ) : (
        <div className="grid gap-3">
          <div className="grid gap-1.5">
            <Label htmlFor="tg-token">Bot token</Label>
            <Input
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
          <div className="flex flex-wrap gap-2 pt-1">
            <Button onClick={submit} disabled={saving}>
              {saving ? "Saving…" : "Save"}
            </Button>
            <Button
              variant="ghost"
              onClick={sendTest}
              disabled={testing || saving}
              title="Send a test message to verify the credentials"
            >
              <Send className="h-3.5 w-3.5" />
              {testing ? "Sending…" : "Send test"}
            </Button>
            <div className="flex-1" />
            <Button
              variant="ghost"
              onClick={clear}
              disabled={saving || (!tokenAlreadySet && !chatId)}
              className="text-fg-dim hover:text-destructive"
            >
              Clear
            </Button>
          </div>
        </div>
      )}
    </section>
  );
}

export default function Page() {
  return <SettingsPage />;
}
