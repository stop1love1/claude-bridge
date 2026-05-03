import { useState } from "react";
import { useSearchParams } from "react-router-dom";
import {
  FolderTree,
  KeyRound,
  Send,
  Settings as SettingsIcon,
  User,
} from "lucide-react";
import { api, getToken, setToken } from "@/api/client";
import { useHealth } from "@/api/queries";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PublicUrlSection } from "@/components/settings/PublicUrlSection";
import { DetectSettingsSection } from "@/components/settings/DetectSettingsSection";
import { TrustedDevicesSection } from "@/components/settings/TrustedDevicesSection";
import { cn } from "@/lib/cn";

type TestState =
  | { kind: "idle" }
  | { kind: "pending" }
  | { kind: "ok"; version?: string; uptime?: number }
  | { kind: "auth" }
  | { kind: "err"; message: string };

/**
 * Bridge-wide settings. Sections mirror main's layout (auth, public URL,
 * detect, apps registry root, trusted devices, telegram bot, telegram
 * user) so the operator's muscle memory carries over. A few sections
 * are stubs because the Go bridge hasn't ported their endpoints yet —
 * each one names the missing endpoint inline so the gap is visible.
 */
export default function Settings() {
  const [params] = useSearchParams();
  const reason = params.get("reason");

  return (
    <div className="mx-auto w-full max-w-3xl p-4 sm:p-6 space-y-6 sm:space-y-8">
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

      {/* Core sections — order mirrors main's settings page so the
          operator's muscle memory carries over. */}
      <PublicUrlSection />
      <DetectSettingsSection />
      <TrustedDevicesSection />
      <TelegramBotStub />
      <TelegramUserStub />

      {/* SPA-specific extras — auth (bridge token) + apps registry root
          stub. Pinned to the bottom so the canonical sections above
          aren't perturbed when these eventually move into main. */}
      <AuthSection reason={reason} />
      <ScanRootsSection />
    </div>
  );
}

/* ─────────────────────── auth ─────────────────────── */

function AuthSection({ reason }: { reason: string | null }) {
  const [tok, setLocalToken] = useState(getToken());
  const [reveal, setReveal] = useState(false);
  const [test, setTest] = useState<TestState>({ kind: "idle" });
  const { data: health } = useHealth(0);

  function save() {
    setToken(tok.trim());
    setTest({ kind: "idle" });
  }

  async function tryConnection() {
    setTest({ kind: "pending" });
    setToken(tok.trim());
    try {
      const h = await api.health({ silentAuth: true });
      setTest({ kind: "ok", version: h.version, uptime: h.uptime });
    } catch (e) {
      const err = e as { status?: number; message?: string };
      if (err.status === 401) setTest({ kind: "auth" });
      else
        setTest({ kind: "err", message: err.message ?? "request failed" });
    }
  }

  return (
    <section className="rounded-lg border border-border bg-card p-4">
      <div className="mb-1 flex items-center gap-2">
        <KeyRound size={14} className="text-primary" />
        <h3 className="text-[13px] sm:text-sm font-semibold">Auth</h3>
      </div>
      <p className="mb-4 text-[11px] text-muted-foreground">
        The bridge requires{" "}
        <span className="font-mono text-foreground">x-bridge-internal-token</span> on
        every request — except when it runs with{" "}
        <span className="font-mono text-foreground">--localhost-only</span>, where
        loopback bypasses auth.
      </p>

      {reason === "auth" && (
        <div className="mb-4 rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-xs text-warning">
          Your last request was rejected with 401 — paste a fresh token below.
        </div>
      )}

      <Label htmlFor="bridge-token">Internal token</Label>
      <div className="mt-1.5 flex items-stretch gap-2">
        <Input
          id="bridge-token"
          type={reveal ? "text" : "password"}
          value={tok}
          onChange={(e) => setLocalToken(e.target.value)}
          placeholder="paste BRIDGE_INTERNAL_TOKEN…"
          className="flex-1"
        />
        <Button
          type="button"
          variant="outline"
          onClick={() => setReveal((v) => !v)}
        >
          {reveal ? "Hide" : "Show"}
        </Button>
      </div>

      <div className="mt-3 flex items-center gap-2">
        <Button onClick={save}>Save</Button>
        <Button variant="outline" onClick={() => void tryConnection()}>
          Test connection
        </Button>
      </div>

      {test.kind !== "idle" && (
        <div
          className={cn(
            "mt-3 rounded-md border px-3 py-2 text-xs",
            test.kind === "ok" &&
              "border-success/40 bg-success/10 text-success",
            test.kind === "auth" &&
              "border-warning/40 bg-warning/10 text-warning",
            test.kind === "err" &&
              "border-destructive/40 bg-destructive/10 text-destructive",
            test.kind === "pending" && "border-border text-muted-foreground",
          )}
        >
          {test.kind === "pending" && "Checking…"}
          {test.kind === "ok" &&
            `Online — bridge ${test.version ?? "?"} · uptime ${formatUptime(
              test.uptime,
            )}`}
          {test.kind === "auth" && "401 unauthorized — token rejected"}
          {test.kind === "err" && `Error: ${test.message}`}
        </div>
      )}

      <div className="mt-5 grid grid-cols-2 gap-3">
        <Card label="Bridge version" value={health?.version ?? "—"} />
        <Card label="Uptime" value={formatUptime(health?.uptime)} />
      </div>
    </section>
  );
}

/* ─────────────────────── apps registry root ─────────────────────── */

function ScanRootsSection() {
  return (
    <section className="rounded-lg border border-border bg-card p-4">
      <div className="mb-1 flex items-center gap-2">
        <FolderTree size={14} className="text-primary" />
        <h3 className="text-[13px] sm:text-sm font-semibold">Apps registry root</h3>
      </div>
      <p className="mb-3 text-[11px] text-muted-foreground">
        The directory tree the auto-detect dialog walks when it scans for
        sibling app folders. Defaults to the bridge&apos;s parent dir; the
        editor for explicit roots isn&apos;t ported yet — use auto-detect from
        the apps page in the meantime.
      </p>
      <div className="rounded-md border border-dashed border-border bg-background/50 px-3 py-2 text-xs text-muted-foreground">
        Scan-roots editor pending — using bridge default root.
      </div>
    </section>
  );
}

/* ─────────────────────── telegram stubs ─────────────────────── */

function TelegramBotStub() {
  return (
    <section className="rounded-lg border border-border bg-card p-4 opacity-90">
      <div className="mb-1 flex items-center gap-2">
        <Send size={14} className="text-primary" />
        <h3 className="text-[13px] sm:text-sm font-semibold">Telegram notifier</h3>
      </div>
      <p className="text-[11px] text-muted-foreground">
        Telegram integration not yet ported — coming soon. (Will surface bot
        token + chat id, forward-chat mode, notification level.)
      </p>
    </section>
  );
}

function TelegramUserStub() {
  return (
    <section className="rounded-lg border border-border bg-card p-4 opacity-90">
      <div className="mb-1 flex items-center gap-2">
        <User size={14} className="text-primary" />
        <h3 className="text-[13px] sm:text-sm font-semibold">Telegram user (MTProto)</h3>
      </div>
      <p className="text-[11px] text-muted-foreground">
        MTProto user-mode session not yet ported — coming soon. (Will surface
        api id/hash, session string, target chat id.)
      </p>
    </section>
  );
}

/* ─────────────────────── helpers ─────────────────────── */

function Card({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-border bg-background p-3">
      <div className="text-[10.5px] text-muted-foreground">{label}</div>
      <div className="mt-1.5 text-sm font-mono tabular-nums text-foreground">
        {value}
      </div>
    </div>
  );
}

function formatUptime(s: number | undefined): string {
  if (s === undefined || s === null) return "—";
  if (s < 60) return `${Math.floor(s)}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}
