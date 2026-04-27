"use client";

import { useEffect, useState } from "react";
import { Send, Settings as SettingsIcon, ShieldCheck, Sparkles, Trash2, User } from "lucide-react";
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
          <TrustedDevicesSection />
          <TelegramSettingsSection />
          <TelegramUserSection />
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

function TelegramUserSection() {
  const [apiId, setApiId] = useState<string>("");
  const [apiHash, setApiHash] = useState<string>("");
  const [session, setSession] = useState<string>("");
  const [targetChatId, setTargetChatId] = useState<string>("");
  const [maskedApiHash, setMaskedApiHash] = useState<string>("");
  const [maskedSession, setMaskedSession] = useState<string>("");
  const [apiHashSet, setApiHashSet] = useState(false);
  const [sessionSet, setSessionSet] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const toast = useToast();

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const s = await api.telegramUserSettings();
        if (cancelled) return;
        setApiId(s.apiId > 0 ? String(s.apiId) : "");
        setMaskedApiHash(s.apiHash);
        setMaskedSession(s.session);
        setApiHashSet(s.apiHashSet);
        setSessionSet(s.sessionSet);
        setTargetChatId(s.targetChatId);
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
      // Empty apiHash / session = keep existing (these are sensitive,
      // require the operator to type a new value to overwrite).
      // Empty apiId field = keep existing too, but only when there's
      // already one saved; otherwise we need it to be > 0 to enable
      // the user-client at all.
      const patch: {
        apiId?: number;
        apiHash?: string;
        session?: string;
        targetChatId?: string;
      } = { targetChatId };
      const apiIdNum = Number(apiId);
      if (apiId.trim().length > 0 && Number.isFinite(apiIdNum)) {
        patch.apiId = apiIdNum;
      }
      if (apiHash.trim().length > 0) patch.apiHash = apiHash.trim();
      if (session.trim().length > 0) patch.session = session.trim();
      const next = await api.updateTelegramUserSettings(patch);
      setApiId(next.apiId > 0 ? String(next.apiId) : "");
      setMaskedApiHash(next.apiHash);
      setMaskedSession(next.session);
      setApiHashSet(next.apiHashSet);
      setSessionSet(next.sessionSet);
      setTargetChatId(next.targetChatId);
      setApiHash("");
      setSession("");
      toast("success", "Telegram user-client saved");
    } catch (e) {
      toast("error", (e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const sendTest = async () => {
    setTesting(true);
    try {
      const r = await api.telegramUserTest();
      if (r.ok === true) {
        const me = r.me;
        const label = me.username
          ? `@${me.username}`
          : me.firstName || `id ${me.id}`;
        toast("success", `Logged in as ${label}`);
      } else {
        toast("error", `User-client: ${r.reason}`);
      }
    } finally {
      setTesting(false);
    }
  };

  const clear = async () => {
    setSaving(true);
    try {
      await api.clearTelegramUserSettings();
      setApiId("");
      setApiHash("");
      setSession("");
      setTargetChatId("");
      setMaskedApiHash("");
      setMaskedSession("");
      setApiHashSet(false);
      setSessionSet(false);
      toast("info", "Telegram user-client cleared");
    } catch (e) {
      toast("error", (e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="rounded-lg border border-border bg-card p-4">
      <div className="flex items-center gap-2 mb-1">
        <User size={14} className="text-primary" />
        <h3 className="text-sm font-semibold">
          Telegram user-client (MTProto)
        </h3>
      </div>
      <p className="text-[11px] text-muted-foreground mb-2">
        Posts as your <strong>own</strong> Telegram account (gram-js / MTProto).
        Use this when the bot can&apos;t deliver — e.g. it&apos;s restricted,
        not added to a chat, or you want to message a bot. Outbound goes
        through both channels in parallel; inbound commands also work in
        DMs to your own account.
      </p>
      <p className="text-[11px] text-muted-foreground mb-4">
        First-time setup needs phone + login code:{" "}
        <code className="font-mono">bun scripts/telegram-login.ts</code>. The
        script writes <code className="font-mono">apiId</code>,{" "}
        <code className="font-mono">apiHash</code>, and the resulting
        StringSession into <code className="font-mono">~/.claude/bridge.json</code>{" "}
        — after that this form just lets you tweak{" "}
        <code className="font-mono">targetChatId</code> or rotate session.
        Get <code className="font-mono">apiId</code>/
        <code className="font-mono">apiHash</code> at{" "}
        <code className="font-mono">my.telegram.org/apps</code>.
      </p>

      {loading ? (
        <ListSkeleton rows={3} />
      ) : (
        <div className="grid gap-3">
          <div className="grid gap-1.5">
            <Label htmlFor="tg-api-id">apiId</Label>
            <Input
              id="tg-api-id"
              value={apiId}
              onChange={(e) => setApiId(e.target.value)}
              placeholder="e.g. 12345678"
              autoComplete="off"
              spellCheck={false}
              inputMode="numeric"
            />
            <p className="text-[11px] text-muted-foreground">
              Numeric app id from my.telegram.org/apps.
            </p>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="tg-api-hash">apiHash</Label>
            <Input
              id="tg-api-hash"
              value={apiHash}
              onChange={(e) => setApiHash(e.target.value)}
              placeholder={
                apiHashSet
                  ? `${maskedApiHash} (leave blank to keep)`
                  : "32-character hex string"
              }
              autoComplete="off"
              spellCheck={false}
              type="password"
            />
            <p className="text-[11px] text-muted-foreground">
              {apiHashSet
                ? "Already saved. Type a new value to replace it."
                : "Sensitive — paired with apiId, identifies your registered Telegram app."}
            </p>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="tg-session">StringSession</Label>
            <Input
              id="tg-session"
              value={session}
              onChange={(e) => setSession(e.target.value)}
              placeholder={
                sessionSet
                  ? `${maskedSession} (leave blank to keep)`
                  : "Run `bun scripts/telegram-login.ts` to mint one"
              }
              autoComplete="off"
              spellCheck={false}
              type="password"
            />
            <p className="text-[11px] text-muted-foreground">
              {sessionSet
                ? "A live session is saved. Paste a new one to rotate."
                : "Empty until you log in via the CLI script."}
            </p>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="tg-user-target">Target chat id</Label>
            <Input
              id="tg-user-target"
              value={targetChatId}
              onChange={(e) => setTargetChatId(e.target.value)}
              placeholder='blank = "Saved Messages"'
              autoComplete="off"
              spellCheck={false}
            />
            <p className="text-[11px] text-muted-foreground">
              Where outbound notifications post. Numeric id, @username, or
              blank for your own Saved Messages chat. Inbound commands are
              ALSO restricted to messages from this id when it&apos;s numeric
              — set it to your own user id for the strictest allowlist.
            </p>
          </div>
          <div className="flex flex-wrap gap-2 pt-1">
            <Button onClick={submit} disabled={saving}>
              {saving ? "Saving…" : "Save"}
            </Button>
            <Button
              variant="ghost"
              onClick={sendTest}
              disabled={testing || saving || !sessionSet}
              title={
                sessionSet
                  ? "Verify the session is live + post a test message"
                  : "Save a session first"
              }
            >
              <Send className="h-3.5 w-3.5" />
              {testing ? "Testing…" : "Send test"}
            </Button>
            <div className="flex-1" />
            <Button
              variant="ghost"
              onClick={clear}
              disabled={saving || (!sessionSet && !apiHashSet && !targetChatId)}
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

interface TrustedDeviceRow {
  id: string;
  label: string | null;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
  /** True when this row matches the cookie the operator is signed in with. */
  isCurrent?: boolean;
}

function TrustedDevicesSection() {
  const [devices, setDevices] = useState<TrustedDeviceRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [revoking, setRevoking] = useState<string | null>(null);
  const toast = useToast();

  const reload = async () => {
    try {
      const r = await api.authDevices();
      setDevices(r.devices);
    } catch (e) {
      toast("error", (e as Error).message);
    }
  };

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const r = await api.authDevices();
        if (!cancelled) setDevices(r.devices);
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

  const revoke = async (id: string) => {
    // Defensive: the trash button is already hidden for the current
    // device, but a stale list could still let one slip through.
    // Refusing here matches the server-side guard so the UX is
    // consistent regardless of which path raced.
    const target = devices.find((d) => d.id === id);
    if (target?.isCurrent) {
      toast(
        "error",
        "Can't revoke the current device — use Sign Out instead.",
      );
      return;
    }
    setRevoking(id);
    try {
      await api.revokeAuthDevice(id);
      toast("info", "Device revoked. Its next page load will redirect to login.");
      await reload();
    } catch (e) {
      toast("error", (e as Error).message);
    } finally {
      setRevoking(null);
    }
  };

  return (
    <section className="rounded-lg border border-border bg-card p-4">
      <div className="flex items-center gap-2 mb-1">
        <ShieldCheck size={14} className="text-primary" />
        <h3 className="text-sm font-semibold">Trusted devices</h3>
      </div>
      <p className="text-[11px] text-muted-foreground mb-4">
        Browsers where you ticked &ldquo;Trust this device&rdquo; at sign-in.
        Each entry holds a 30-day session cookie. Revoke any you don&apos;t
        recognize — the next request from that device will be rejected
        and bounced back to <code className="font-mono">/login</code>.
      </p>

      {loading ? (
        <ListSkeleton rows={2} />
      ) : devices.length === 0 ? (
        <p className="text-xs text-muted-foreground italic">
          No trusted devices. Tick &ldquo;Trust this device&rdquo; on the
          login page to remember a browser.
        </p>
      ) : (
        <div className="grid gap-2">
          {devices.map((d) => (
            <div
              key={d.id}
              className={`rounded-md border px-3 py-2 flex items-center gap-3 ${
                d.isCurrent
                  ? "border-primary/40 bg-primary/5"
                  : "border-border bg-background"
              }`}
            >
              <ShieldCheck size={14} className="text-primary shrink-0" />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-1.5 flex-wrap">
                  <span className="text-xs font-medium truncate">
                    {d.label ?? "Unnamed device"}
                  </span>
                  {d.isCurrent ? (
                    <span className="inline-flex items-center px-1.5 py-px rounded-full bg-primary/15 text-primary text-[9px] font-medium uppercase tracking-wide">
                      This device
                    </span>
                  ) : null}
                </div>
                <div className="text-[11px] text-muted-foreground">
                  Last seen {new Date(d.lastSeenAt).toLocaleString()} · expires{" "}
                  {new Date(d.expiresAt).toLocaleDateString()}
                </div>
              </div>
              {d.isCurrent ? null : (
                // Suppress the trash entirely for the current device — clicking
                // it would either 400 (server guard) or, before that landed,
                // kick off a /login → / reload loop. The "This device" badge
                // beside the label is enough to signal why no trash icon.
                <Button
                  variant="ghost"
                  size="iconSm"
                  onClick={() => revoke(d.id)}
                  disabled={revoking === d.id}
                  title="Revoke this device"
                  className="text-fg-dim hover:text-destructive"
                >
                  <Trash2 size={13} />
                </Button>
              )}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

export default function Page() {
  return <SettingsPage />;
}
