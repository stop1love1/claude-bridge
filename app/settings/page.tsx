"use client";

import { useEffect, useState } from "react";
import {
  Bell,
  Globe,
  Send,
  Settings as SettingsIcon,
  ShieldCheck,
  Sparkles,
  Trash2,
  User,
} from "lucide-react";
import { api } from "@/libs/client/api";
import { usePushSubscribe } from "@/libs/client/usePushSubscribe";
import { HeaderShell } from "../_components/HeaderShell";
import { SettingsCard, SettingsGroup } from "../_components/SettingsCard";
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

function clampMinChars(input: string): number {
  const n = Number(input);
  if (!Number.isFinite(n)) return 40;
  const i = Math.floor(n);
  if (i < 0) return 0;
  if (i > 5000) return 5000;
  return i;
}

function SettingsPage() {
  return (
    <div className="flex flex-col h-screen">
      <HeaderShell active="settings" />
      <main className="flex-1 overflow-y-auto">
        <div className="p-4 sm:p-6 max-w-3xl mx-auto space-y-6 sm:space-y-8">
          <div className="flex items-center gap-2 mb-2">
            <SettingsIcon size={18} className="text-primary" />
            <h2 className="text-base sm:text-lg font-semibold">Settings</h2>
          </div>
          <p className="text-[11px] sm:text-xs text-muted-foreground mt-4">
            Per-machine configuration stored in{" "}
            <code className="font-mono text-foreground">
              ~/.claude/bridge.json
            </code>
            . Outside the project tree so version updates can&apos;t overwrite
            your bot tokens / detection mode.
          </p>

          <SettingsGroup title="Access" hint="who can reach this bridge, and at what address">
            <PublicUrlSection />
            <TrustedDevicesSection />
          </SettingsGroup>

          <SettingsGroup title="Agent behaviour" hint="how tasks are scoped, gated and dispatched">
            <DetectSettingsSection />
            <PlanGateSettingsSection />
            <ConfidenceSettingsSection />
            <AutoQueueSettingsSection />
          </SettingsGroup>

          <SettingsGroup title="Notifications" hint="how the bridge reaches you when it needs a human">
            <PushNotificationsSection />
            <TelegramSettingsSection />
            <TelegramUserSection />
          </SettingsGroup>
        </div>
      </main>
    </div>
  );
}

function PublicUrlSection() {
  const [publicUrl, setPublicUrl] = useState("");
  const [draft, setDraft] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const toast = useToast();

  useEffect(() => {
    const ac = new AbortController();
    void (async () => {
      try {
        const s = await api.bridgeSettings({ signal: ac.signal });
        if (ac.signal.aborted) return;
        setPublicUrl(s.publicUrl);
        setDraft(s.publicUrl);
      } catch (e) {
        if (ac.signal.aborted) return;
        toast("error", (e as Error).message);
      } finally {
        if (!ac.signal.aborted) setLoading(false);
      }
    })();
    return () => ac.abort();
  }, [toast]);

  const submit = async () => {
    setSaving(true);
    try {
      const next = await api.updateBridgeSettings({ publicUrl: draft.trim() });
      setPublicUrl(next.publicUrl);
      setDraft(next.publicUrl);
      toast(
        "success",
        next.publicUrl ? "Public URL saved" : "Public URL cleared",
      );
    } catch (e) {
      toast("error", (e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const clear = async () => {
    setSaving(true);
    try {
      const next = await api.updateBridgeSettings({ publicUrl: "" });
      setPublicUrl(next.publicUrl);
      setDraft("");
      toast("info", "Public URL cleared");
    } catch (e) {
      toast("error", (e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const dirty = draft.trim() !== publicUrl;

  return (
    <SettingsCard
      title="Public URL"
      icon={<Globe size={14} />}
      summary={loading ? "…" : draft.trim() || "not set — links use localhost"}
      changed={!!draft.trim()}
    >
      <p className="text-[11px] text-muted-foreground mb-4">
        The origin the bridge is reachable at after deploy. Used to render
        clickable links — Telegram task notifications, magic-link emails,
        webhook payloads. Leave blank when running locally; fill in when
        running behind a reverse proxy / public domain.
      </p>

      {loading ? (
        <ListSkeleton rows={1} />
      ) : (
        <div className="grid gap-3">
          <div className="grid gap-1.5">
            <Label htmlFor="bridge-public-url">Public origin</Label>
            <Input
              id="bridge-public-url"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="https://bridge.example.com"
              autoComplete="off"
              spellCheck={false}
              inputMode="url"
            />
            <p className="text-[11px] text-muted-foreground">
              Origin only — no path / query. Path / query / hash get stripped
              on save. Must use http:// or https://.
            </p>
          </div>
          <div className="flex flex-wrap gap-2 pt-1">
            <Button onClick={submit} disabled={saving || !dirty}>
              {saving ? "Saving…" : "Save"}
            </Button>
            <div className="flex-1" />
            <Button
              variant="ghost"
              onClick={clear}
              disabled={saving || !publicUrl}
              className="text-fg-dim hover:text-destructive"
            >
              Clear
            </Button>
          </div>
        </div>
      )}
    </SettingsCard>
  );
}

function PushNotificationsSection() {
  const { state, busy, error, supported, subscribe, unsubscribe } = usePushSubscribe();

  const statusLabel: Record<typeof state, string> = {
    unsupported: "Not supported in this browser",
    denied: "Blocked — allow notifications for this site in your browser settings",
    default: "Not enabled on this device",
    subscribed: "Enabled on this device",
  };

  return (
    <SettingsCard
      title="Push notifications"
      icon={<Bell size={14} />}
      summary={statusLabel[state]}
    >
      <p className="text-[11px] text-muted-foreground mb-4">
        Get native OS notifications on this device for the same events the
        Telegram notifier surfaces — permission requests, tasks blocked or
        ready for review, and plans awaiting approval. No bot token
        required; this uses the browser&apos;s own Push API. Enable it
        separately on every browser/device you want to hear from.
      </p>

      <div className="flex flex-wrap items-center gap-3">
        <span
          className={`text-xs ${state === "subscribed" ? "text-primary" : "text-muted-foreground"}`}
        >
          {statusLabel[state]}
        </span>
        <div className="flex-1" />
        {state === "subscribed" ? (
          <Button
            variant="ghost"
            onClick={unsubscribe}
            disabled={busy}
            className="text-fg-dim hover:text-destructive"
          >
            <Bell className="h-3.5 w-3.5" />
            {busy ? "Disabling…" : "Disable"}
          </Button>
        ) : (
          <Button onClick={subscribe} disabled={busy || !supported || state === "denied"}>
            <Bell className="h-3.5 w-3.5" />
            {busy ? "Enabling…" : "Enable notifications"}
          </Button>
        )}
      </div>
      {error ? <p className="mt-2 text-[11px] text-destructive">{error}</p> : null}
    </SettingsCard>
  );
}

function DetectSettingsSection() {
  const [source, setSource] = useState<DetectSource>("auto");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const toast = useToast();

  useEffect(() => {
    const ac = new AbortController();
    void (async () => {
      try {
        const s = await api.detectSettings({ signal: ac.signal });
        if (!ac.signal.aborted) setSource(s.source);
      } catch (e) {
        if (ac.signal.aborted) return;
        toast("error", (e as Error).message);
      } finally {
        if (!ac.signal.aborted) setLoading(false);
      }
    })();
    return () => ac.abort();
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
    <SettingsCard
      title="Scope detection"
      icon={<Sparkles size={14} />}
      summary={loading ? "…" : source === "auto" ? "auto" : source === "llm" ? "LLM only" : "heuristic only"}
      changed={source !== "auto"}
    >
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
    </SettingsCard>
  );
}

function PlanGateSettingsSection() {
  const [operatorEnabled, setOperatorEnabled] = useState(true);
  const [maxClarifyRounds, setMaxClarifyRounds] = useState(3);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const toast = useToast();

  useEffect(() => {
    const ac = new AbortController();
    void (async () => {
      try {
        const s = await api.planGateSettings({ signal: ac.signal });
        if (ac.signal.aborted) return;
        setOperatorEnabled(s.operatorEnabled);
        setMaxClarifyRounds(s.maxClarifyRounds);
      } catch (e) {
        if (ac.signal.aborted) return;
        toast("error", (e as Error).message);
      } finally {
        if (!ac.signal.aborted) setLoading(false);
      }
    })();
    return () => ac.abort();
  }, [toast]);

  const save = async (patch: { operatorEnabled?: boolean; maxClarifyRounds?: number }) => {
    setSaving(true);
    try {
      const next = await api.updatePlanGateSettings(patch);
      setOperatorEnabled(next.operatorEnabled);
      setMaxClarifyRounds(next.maxClarifyRounds);
      toast("success", "Planning gate saved");
    } catch (e) {
      toast("error", (e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <SettingsCard
      title="Planning gate"
      icon={<ShieldCheck size={14} />}
      summary={loading ? "…" : operatorEnabled ? `on · up to ${maxClarifyRounds} clarify rounds` : "off for the operator"}
    >
      <p className="text-[11px] text-muted-foreground mb-4">
        Before a coder runs, the bridge has a planner restate the goal and
        draft a plan; coding is blocked until the plan is approved.{" "}
        <strong>Guests (share links) are always gated</strong> regardless of
        this toggle — it only controls whether the gate also applies to you,
        the operator. In smart mode a clear operator prompt auto-approves and
        runs straight through; only ambiguous prompts pause for your decision.
      </p>

      {loading ? (
        <ListSkeleton rows={2} />
      ) : (
        <div className="grid gap-3">
          <button
            type="button"
            onClick={() => save({ operatorEnabled: !operatorEnabled })}
            disabled={saving}
            aria-pressed={operatorEnabled}
            className={`text-left rounded-md border p-3 transition-colors disabled:opacity-50 ${
              operatorEnabled
                ? "border-primary/40 bg-primary/5"
                : "border-border hover:border-primary/30 hover:bg-accent/30"
            }`}
          >
            <div className="flex items-center gap-2">
              <span
                className={`inline-flex h-3.5 w-3.5 rounded-full border ${
                  operatorEnabled ? "border-primary bg-primary" : "border-border bg-transparent"
                }`}
                aria-hidden
              />
              <span className="text-sm font-medium">
                Gate the operator too {operatorEnabled ? "(on)" : "(off)"}
              </span>
            </div>
            <p className="mt-1 ml-5 text-[11px] text-muted-foreground">
              {operatorEnabled
                ? "Your own tasks go through the planning gate (smart — clear prompts auto-approve)."
                : "Your own tasks skip the gate entirely. Guest contributions are still gated."}
            </p>
          </button>

          <div className="grid gap-1.5">
            <Label htmlFor="gate-rounds">Max clarify rounds</Label>
            <Input
              id="gate-rounds"
              type="number"
              min={1}
              max={10}
              value={String(maxClarifyRounds)}
              onChange={(e) => setMaxClarifyRounds(Math.max(1, Math.floor(Number(e.target.value) || 1)))}
              onBlur={() => save({ maxClarifyRounds })}
              disabled={saving}
            />
            <p className="text-[11px] text-muted-foreground">
              How many clarify cycles before the gate forces a manual decision.
              Default 3.
            </p>
          </div>
        </div>
      )}
    </SettingsCard>
  );
}

function ConfidenceSettingsSection() {
  const [enabled, setEnabled] = useState(true);
  const [threshold, setThreshold] = useState(70);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const toast = useToast();

  useEffect(() => {
    const ac = new AbortController();
    void (async () => {
      try {
        const s = await api.confidenceSettings({ signal: ac.signal });
        if (ac.signal.aborted) return;
        setEnabled(s.enabled);
        setThreshold(s.threshold);
      } catch (e) {
        if (ac.signal.aborted) return;
        toast("error", (e as Error).message);
      } finally {
        if (!ac.signal.aborted) setLoading(false);
      }
    })();
    return () => ac.abort();
  }, [toast]);

  const save = async (patch: { enabled?: boolean; threshold?: number }) => {
    setSaving(true);
    try {
      const next = await api.updateConfidenceSettings(patch);
      setEnabled(next.enabled);
      setThreshold(next.threshold);
      toast("success", "Confidence gate saved");
    } catch (e) {
      toast("error", (e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <SettingsCard
      title="Confidence gate"
      icon={<ShieldCheck size={14} />}
      summary={loading ? "…" : enabled ? `hold below ${threshold}` : "off"}
      changed={enabled}
    >
      <p className="text-[11px] text-muted-foreground mb-4">
        After the quality gates pass, the bridge scores each run 0–100 from the gate results
        (verify, claim-vs-diff, style, semantic panel). Below the threshold it <strong>holds
        the outward action</strong> (push / merge / PR) and flags the run for your review —
        the local commit still lands. Worktree-mode runs record the score but aren&apos;t held.
      </p>

      {loading ? (
        <ListSkeleton rows={2} />
      ) : (
        <div className="grid gap-3">
          <button
            type="button"
            onClick={() => save({ enabled: !enabled })}
            disabled={saving}
            aria-pressed={enabled}
            className={`text-left rounded-md border p-3 transition-colors disabled:opacity-50 ${
              enabled ? "border-primary/40 bg-primary/5" : "border-border hover:border-primary/30 hover:bg-accent/30"
            }`}
          >
            <div className="flex items-center gap-2">
              <span className={`inline-flex h-3.5 w-3.5 rounded-full border ${enabled ? "border-primary bg-primary" : "border-border bg-transparent"}`} aria-hidden />
              <span className="text-sm font-medium">Hold low-confidence runs {enabled ? "(on)" : "(off)"}</span>
            </div>
            <p className="mt-1 ml-5 text-[11px] text-muted-foreground">
              {enabled
                ? "Below-threshold runs hold push/integration for your review."
                : "Scores are still recorded, but nothing is ever held."}
            </p>
          </button>

          <div className="grid gap-1.5">
            <Label htmlFor="conf-threshold">Threshold (0–100)</Label>
            <Input
              id="conf-threshold"
              type="number"
              min={0}
              max={100}
              value={String(threshold)}
              onChange={(e) => setThreshold(Math.max(0, Math.min(100, Math.floor(Number(e.target.value) || 0))))}
              onBlur={() => save({ threshold })}
              disabled={saving || !enabled}
            />
            <p className="text-[11px] text-muted-foreground">
              Runs scoring below this hold their outward action. Default 70.
            </p>
          </div>
        </div>
      )}
    </SettingsCard>
  );
}

function AutoQueueSettingsSection() {
  const [enabled, setEnabled] = useState(false);
  const [maxConcurrent, setMaxConcurrent] = useState(1);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const toast = useToast();

  useEffect(() => {
    const ac = new AbortController();
    void (async () => {
      try {
        const s = await api.autoQueueSettings({ signal: ac.signal });
        if (ac.signal.aborted) return;
        setEnabled(s.enabled);
        setMaxConcurrent(s.maxConcurrent);
      } catch (e) {
        if (ac.signal.aborted) return;
        toast("error", (e as Error).message);
      } finally {
        if (!ac.signal.aborted) setLoading(false);
      }
    })();
    return () => ac.abort();
  }, [toast]);

  const save = async (patch: { enabled?: boolean; maxConcurrent?: number }) => {
    setSaving(true);
    try {
      const next = await api.updateAutoQueueSettings(patch);
      setEnabled(next.enabled);
      setMaxConcurrent(next.maxConcurrent);
      toast("success", "Auto-queue saved");
    } catch (e) {
      toast("error", (e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <SettingsCard
      title="Auto-queue"
      icon={<Sparkles size={14} />}
      summary={loading ? "…" : enabled ? `on · max ${maxConcurrent} coordinators` : "off"}
      changed={enabled}
    >
      <p className="text-[11px] text-muted-foreground mb-4">
        Lets the bridge dispatch <strong>TODO</strong> tasks on its own, oldest
        first, without waiting for you to open one. Every 30s the scheduler
        checks how many coordinators are already running (or about to be) and,
        if under the cap below, spawns the next eligible TODO task — the same
        path <code className="font-mono">/retry</code> uses. Tasks mid-planning
        (awaiting your plan approval) are skipped, never re-dispatched. Off by
        default.
      </p>

      {loading ? (
        <ListSkeleton rows={2} />
      ) : (
        <div className="grid gap-3">
          <button
            type="button"
            onClick={() => save({ enabled: !enabled })}
            disabled={saving}
            aria-pressed={enabled}
            className={`text-left rounded-md border p-3 transition-colors disabled:opacity-50 ${
              enabled ? "border-primary/40 bg-primary/5" : "border-border hover:border-primary/30 hover:bg-accent/30"
            }`}
          >
            <div className="flex items-center gap-2">
              <span className={`inline-flex h-3.5 w-3.5 rounded-full border ${enabled ? "border-primary bg-primary" : "border-border bg-transparent"}`} aria-hidden />
              <span className="text-sm font-medium">Auto-dispatch TODO tasks {enabled ? "(on)" : "(off)"}</span>
            </div>
            <p className="mt-1 ml-5 text-[11px] text-muted-foreground">
              {enabled
                ? "The scheduler spawns the oldest eligible TODO task once a concurrency slot frees up."
                : "Tasks stay in TODO until you dispatch them manually."}
            </p>
          </button>

          <div className="grid gap-1.5">
            <Label htmlFor="auto-queue-max">Max concurrent coordinators</Label>
            <Input
              id="auto-queue-max"
              type="number"
              min={1}
              max={20}
              value={String(maxConcurrent)}
              onChange={(e) => setMaxConcurrent(Math.max(1, Math.min(20, Math.floor(Number(e.target.value) || 1))))}
              onBlur={() => save({ maxConcurrent })}
              disabled={saving || !enabled}
            />
            <p className="text-[11px] text-muted-foreground">
              How many coordinators (across all tasks) may run at once before
              auto-queue holds off dispatching more. Default 1.
            </p>
          </div>
        </div>
      )}
    </SettingsCard>
  );
}

type NotificationLevel = "minimal" | "normal" | "verbose";
type ForwardChatFilter = "important-only" | "all";

const NOTIFICATION_LEVEL_HINT: Record<NotificationLevel, string> = {
  minimal:
    "Coordinator done/failed, any child failure, BLOCKED/DONE moves, permission requests (coalesced per session+tool).",
  normal:
    "Default. Adds child completions and Started moves on top of minimal.",
  verbose:
    "Every transition, every section move, every permission request. Useful for debugging the bridge itself.",
};

function TelegramSettingsSection() {
  const [botToken, setBotToken] = useState("");
  const [chatId, setChatId] = useState("");
  const [maskedToken, setMaskedToken] = useState("");
  const [tokenAlreadySet, setTokenAlreadySet] = useState(false);
  const [forwardChat, setForwardChat] = useState<
    "off" | "coordinator-only" | "all"
  >("off");
  const [forwardChatMinChars, setForwardChatMinChars] = useState<string>("40");
  const [notificationLevel, setNotificationLevel] =
    useState<NotificationLevel>("normal");
  const [forwardChatFilter, setForwardChatFilter] =
    useState<ForwardChatFilter>("important-only");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const toast = useToast();

  useEffect(() => {
    const ac = new AbortController();
    void (async () => {
      try {
        const s = await api.telegramSettings({ signal: ac.signal });
        if (ac.signal.aborted) return;
        setMaskedToken(s.botToken);
        setTokenAlreadySet(s.botTokenSet);
        setChatId(s.chatId);
        setForwardChat(s.forwardChat);
        setForwardChatMinChars(String(s.forwardChatMinChars));
        setNotificationLevel(s.notificationLevel);
        setForwardChatFilter(s.forwardChatFilter);
      } catch (e) {
        if (ac.signal.aborted) return;
        toast("error", (e as Error).message);
      } finally {
        if (!ac.signal.aborted) setLoading(false);
      }
    })();
    return () => ac.abort();
  }, [toast]);

  const submit = async () => {
    setSaving(true);
    try {
      const patch: {
        botToken?: string;
        chatId?: string;
        forwardChat: "off" | "coordinator-only" | "all";
        forwardChatMinChars: number;
        notificationLevel: NotificationLevel;
        forwardChatFilter: ForwardChatFilter;
      } = {
        chatId: chatId.trim(),
        forwardChat,
        forwardChatMinChars: clampMinChars(forwardChatMinChars),
        notificationLevel,
        forwardChatFilter,
      };
      if (botToken.trim().length > 0) patch.botToken = botToken.trim();
      const next = await api.updateTelegramSettings(patch);
      setBotToken("");
      setMaskedToken(next.botToken);
      setTokenAlreadySet(next.botTokenSet);
      setChatId(next.chatId);
      setForwardChat(next.forwardChat);
      setForwardChatMinChars(String(next.forwardChatMinChars));
      setNotificationLevel(next.notificationLevel);
      setForwardChatFilter(next.forwardChatFilter);
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
      const next = await api.updateTelegramSettings({
        botToken: "",
        chatId: "",
        forwardChat: "off",
        forwardChatMinChars: 40,
        notificationLevel: "normal",
        forwardChatFilter: "important-only",
      });
      setBotToken("");
      setMaskedToken(next.botToken);
      setTokenAlreadySet(next.botTokenSet);
      setChatId(next.chatId);
      setForwardChat(next.forwardChat);
      setForwardChatMinChars(String(next.forwardChatMinChars));
      setNotificationLevel(next.notificationLevel);
      setForwardChatFilter(next.forwardChatFilter);
      toast("info", "Telegram settings cleared");
    } catch (e) {
      toast("error", (e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <SettingsCard
      title="Telegram notifier"
      icon={<Send size={14} />}
      summary={tokenAlreadySet ? "bot token saved" : "no bot token"}
      changed={tokenAlreadySet}
    >
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
          <div className="grid gap-1.5 pt-1 border-t border-border/60 mt-1">
            <Label htmlFor="tg-level">Notification level</Label>
            <select
              id="tg-level"
              className="h-8 rounded-md border border-border bg-background px-2 text-sm"
              value={notificationLevel}
              onChange={(e) =>
                setNotificationLevel(e.target.value as NotificationLevel)
              }
            >
              <option value="minimal">
                Minimal — only what needs your attention
              </option>
              <option value="normal">
                Normal — recommended default
              </option>
              <option value="verbose">
                Verbose — every event (legacy)
              </option>
            </select>
            <p className="text-[11px] text-muted-foreground">
              {NOTIFICATION_LEVEL_HINT[notificationLevel]}
            </p>
          </div>
          <div className="grid gap-1.5 pt-1 border-t border-border/60 mt-1">
            <Label htmlFor="tg-forward">Forward chat to Telegram</Label>
            <select
              id="tg-forward"
              className="h-8 rounded-md border border-border bg-background px-2 text-sm"
              value={forwardChat}
              onChange={(e) =>
                setForwardChat(
                  e.target.value as "off" | "coordinator-only" | "all",
                )
              }
            >
              <option value="off">Off — lifecycle events only (default)</option>
              <option value="coordinator-only">
                Coordinator only — mirror coordinator chat
              </option>
              <option value="all">All — mirror every spawned agent&apos;s chat</option>
            </select>
            <p className="text-[11px] text-muted-foreground">
              Mirrors assistant prose from spawned Claude sessions to your
              Telegram chat. Quality-gate runs (style-critic, semantic-verifier)
              are always skipped.
            </p>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="tg-forward-filter">Chat filter</Label>
            <select
              id="tg-forward-filter"
              className="h-8 rounded-md border border-border bg-background px-2 text-sm"
              value={forwardChatFilter}
              onChange={(e) =>
                setForwardChatFilter(e.target.value as ForwardChatFilter)
              }
              disabled={forwardChat === "off"}
            >
              <option value="important-only">
                Important only — NEEDS-DECISION / BLOCKED / READY FOR REVIEW
              </option>
              <option value="all">
                All — every assistant turn above min length
              </option>
            </select>
            <p className="text-[11px] text-muted-foreground">
              When &ldquo;Important only&rdquo;, only forward turns whose text
              contains the coordinator escalation tokens. Lets agents think out
              loud without paging you.
            </p>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="tg-forward-min">Minimum length (chars)</Label>
            <Input
              id="tg-forward-min"
              type="number"
              min={0}
              max={5000}
              value={forwardChatMinChars}
              onChange={(e) => setForwardChatMinChars(e.target.value)}
              disabled={forwardChat === "off"}
            />
            <p className="text-[11px] text-muted-foreground">
              Skip messages shorter than this after trim. Filters &quot;OK.&quot;
              / &quot;Done.&quot; chatter. Default 40.
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
    </SettingsCard>
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
    const ac = new AbortController();
    void (async () => {
      try {
        const s = await api.telegramUserSettings({ signal: ac.signal });
        if (ac.signal.aborted) return;
        setApiId(s.apiId > 0 ? String(s.apiId) : "");
        setMaskedApiHash(s.apiHash);
        setMaskedSession(s.session);
        setApiHashSet(s.apiHashSet);
        setSessionSet(s.sessionSet);
        setTargetChatId(s.targetChatId);
      } catch (e) {
        if (ac.signal.aborted) return;
        toast("error", (e as Error).message);
      } finally {
        if (!ac.signal.aborted) setLoading(false);
      }
    })();
    return () => ac.abort();
  }, [toast]);

  const submit = async () => {
    setSaving(true);
    try {
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
    <SettingsCard
      title="Telegram user-client (MTProto)"
      icon={<User size={14} />}
      summary={sessionSet ? "signed in" : apiHashSet ? "api hash saved, not signed in" : "not configured"}
      changed={sessionSet}
    >
      <p className="text-[11px] text-muted-foreground mb-2">
        Posts as your <strong>own</strong> Telegram account (gram-js / MTProto).
        Use this when the bot can&apos;t deliver — e.g. it&apos;s restricted,
        not added to a chat, or you want to message a bot. Outbound goes
        through both channels in parallel; inbound commands also work in
        DMs to your own account.
      </p>
      <p className="text-[11px] text-muted-foreground mb-4">
        First-time setup needs phone + login code:{" "}
        <code className="font-mono">npm run telegram:login</code>. The
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
                  : "Run `npm run telegram:login` to mint one"
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
    </SettingsCard>
  );
}

interface TrustedDeviceRow {
  id: string;
  label: string | null;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
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
    const ac = new AbortController();
    void (async () => {
      try {
        const r = await api.authDevices({ signal: ac.signal });
        if (!ac.signal.aborted) setDevices(r.devices);
      } catch (e) {
        if (ac.signal.aborted) return;
        toast("error", (e as Error).message);
      } finally {
        if (!ac.signal.aborted) setLoading(false);
      }
    })();
    return () => ac.abort();
  }, [toast]);

  const revoke = async (id: string) => {
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
    <SettingsCard
      title="Trusted devices"
      icon={<ShieldCheck size={14} />}
      summary={loading ? "…" : devices.length === 0 ? "none" : `${devices.length} device${devices.length === 1 ? "" : "s"}`}
    >
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
    </SettingsCard>
  );
}

export default function Page() {
  return <SettingsPage />;
}
