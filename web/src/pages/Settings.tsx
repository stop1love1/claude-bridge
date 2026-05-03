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
    <div className="mx-auto w-full max-w-3xl px-6 py-10 space-y-6">
      <div className="sticky top-0 -mx-6 -mt-10 mb-2 border-b border-border bg-background/95 px-6 pb-3 pt-10 backdrop-blur supports-[backdrop-filter]:bg-background/80">
        <div className="flex items-center gap-2">
          <SettingsIcon size={18} className="text-primary" />
          <h1 className="font-mono text-display font-semibold tracking-tightish text-foreground">
            settings
          </h1>
        </div>
        <p className="mt-1 max-w-xl text-small text-muted-foreground">
          per-machine configuration stored in{" "}
          <span className="font-mono text-foreground">~/.claude/bridge.json</span>
          . outside the project tree so version updates can&apos;t overwrite
          your bot tokens / detection mode. token lives in this browser&apos;s
          localStorage only.
        </p>
      </div>

      <AuthSection reason={reason} />
      <PublicUrlSection />
      <DetectSettingsSection />
      <ScanRootsSection />
      <TrustedDevicesSection />
      <TelegramBotStub />
      <TelegramUserStub />
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
    <section className="rounded-sm border border-border bg-card p-5">
      <div className="mb-1 flex items-center gap-2">
        <KeyRound size={14} className="text-primary" />
        <h2 className="font-mono text-small uppercase tracking-wideish text-foreground">
          auth
        </h2>
      </div>
      <p className="mb-4 text-small text-muted-foreground">
        the bridge requires{" "}
        <span className="font-mono text-foreground">x-bridge-internal-token</span> on
        every request — except when it runs with{" "}
        <span className="font-mono text-foreground">--localhost-only</span>, where
        loopback bypasses auth.
      </p>

      {reason === "auth" && (
        <div className="mb-4 rounded-sm border border-status-doing/40 bg-status-doing/10 px-3 py-2 font-mono text-micro text-status-doing">
          your last request was rejected with 401 — paste a fresh token below.
        </div>
      )}

      <Label htmlFor="bridge-token">internal token</Label>
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
          {reveal ? "hide" : "show"}
        </Button>
      </div>

      <div className="mt-3 flex items-center gap-2">
        <Button onClick={save}>save</Button>
        <Button variant="outline" onClick={() => void tryConnection()}>
          test connection
        </Button>
      </div>

      {test.kind !== "idle" && (
        <div
          className={cn(
            "mt-3 rounded-sm border px-3 py-2 font-mono text-micro tracking-wideish",
            test.kind === "ok" &&
              "border-status-done/40 bg-status-done/10 text-status-done",
            test.kind === "auth" &&
              "border-status-doing/40 bg-status-doing/10 text-status-doing",
            test.kind === "err" &&
              "border-status-blocked/40 bg-status-blocked/10 text-status-blocked",
            test.kind === "pending" && "border-border text-muted-foreground",
          )}
        >
          {test.kind === "pending" && "checking…"}
          {test.kind === "ok" &&
            `online — bridge ${test.version ?? "?"} · uptime ${formatUptime(
              test.uptime,
            )}`}
          {test.kind === "auth" && "401 unauthorized — token rejected"}
          {test.kind === "err" && `error: ${test.message}`}
        </div>
      )}

      <div className="mt-5 grid grid-cols-2 gap-3">
        <Card label="bridge version" value={health?.version ?? "—"} />
        <Card label="uptime" value={formatUptime(health?.uptime)} />
      </div>
    </section>
  );
}

/* ─────────────────────── apps registry root ─────────────────────── */

function ScanRootsSection() {
  return (
    <section className="rounded-sm border border-border bg-card p-5">
      <div className="mb-1 flex items-center gap-2">
        <FolderTree size={14} className="text-primary" />
        <h2 className="font-mono text-small uppercase tracking-wideish text-foreground">
          apps registry root
        </h2>
      </div>
      <p className="mb-3 text-small text-muted-foreground">
        the directory tree the auto-detect dialog walks when it scans for
        sibling app folders. defaults to the bridge&apos;s parent dir; the
        editor for explicit roots isn&apos;t ported yet — use auto-detect from
        the apps page in the meantime.
      </p>
      <div className="rounded-sm border border-dashed border-border bg-background/50 px-3 py-2 font-mono text-micro text-muted-foreground">
        scan-roots editor pending — using bridge default root.
      </div>
    </section>
  );
}

/* ─────────────────────── telegram stubs ─────────────────────── */

function TelegramBotStub() {
  return (
    <section className="rounded-sm border border-border bg-card p-5 opacity-90">
      <div className="mb-1 flex items-center gap-2">
        <Send size={14} className="text-primary" />
        <h2 className="font-mono text-small uppercase tracking-wideish text-foreground">
          telegram bot
        </h2>
      </div>
      <p className="text-small text-muted-foreground">
        telegram integration not yet ported — coming soon. (will surface bot
        token + chat id, forward-chat mode, notification level.)
      </p>
    </section>
  );
}

function TelegramUserStub() {
  return (
    <section className="rounded-sm border border-border bg-card p-5 opacity-90">
      <div className="mb-1 flex items-center gap-2">
        <User size={14} className="text-primary" />
        <h2 className="font-mono text-small uppercase tracking-wideish text-foreground">
          telegram user (MTProto)
        </h2>
      </div>
      <p className="text-small text-muted-foreground">
        MTProto user-mode session not yet ported — coming soon. (will surface
        api id/hash, session string, target chat id.)
      </p>
    </section>
  );
}

/* ─────────────────────── helpers ─────────────────────── */

function Card({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-sm border border-border bg-background p-3">
      <div className="font-mono text-[10px] uppercase tracking-wideish text-muted-foreground">
        {label}
      </div>
      <div className="mt-1.5 font-mono text-small tabular-nums text-foreground">
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
