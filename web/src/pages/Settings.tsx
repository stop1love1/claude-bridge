import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import {
  FolderTree,
  Globe,
  KeyRound,
  Settings as SettingsIcon,
  Sparkles,
} from "lucide-react";
import { api, getToken, setToken } from "@/api/client";
import {
  useBridgeSettings,
  useHealth,
  useUpdateBridgeSettings,
} from "@/api/queries";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/components/Toasts";
import { cn } from "@/lib/cn";

type TestState =
  | { kind: "idle" }
  | { kind: "pending" }
  | { kind: "ok"; version?: string; uptime?: number }
  | { kind: "auth" }
  | { kind: "err"; message: string };

export default function Settings() {
  const [params] = useSearchParams();
  const reason = params.get("reason");

  return (
    <div className="mx-auto w-full max-w-3xl px-6 py-10 space-y-6">
      <div className="flex items-center gap-2">
        <SettingsIcon size={18} className="text-accent" />
        <h1 className="font-mono text-display font-semibold tracking-tightish text-fg">
          settings
        </h1>
      </div>
      <p className="-mt-2 max-w-xl text-small text-muted">
        per-machine configuration stored in{" "}
        <span className="font-mono text-fg">~/.claude/bridge.json</span> and the
        bridge process. token lives in this browser&apos;s localStorage only.
      </p>

      <AuthSection reason={reason} />
      <BridgeSection />
      <DetectSection />
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
    <section className="rounded-sm border border-border bg-surface p-5">
      <div className="mb-1 flex items-center gap-2">
        <KeyRound size={14} className="text-accent" />
        <h2 className="font-mono text-small uppercase tracking-wideish text-fg">
          auth
        </h2>
      </div>
      <p className="mb-4 text-small text-muted">
        the bridge requires{" "}
        <span className="font-mono text-fg">x-bridge-internal-token</span> on
        every request — except when it runs with{" "}
        <span className="font-mono text-fg">--localhost-only</span>, where
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
            test.kind === "pending" && "border-border text-muted",
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

/* ─────────────────────── bridge ─────────────────────── */

function BridgeSection() {
  const { data, isLoading } = useBridgeSettings();
  const update = useUpdateBridgeSettings();
  const toast = useToast();
  const [draft, setDraft] = useState("");
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    if (!hydrated && data) {
      setDraft(typeof data.publicUrl === "string" ? data.publicUrl : "");
      setHydrated(true);
    }
  }, [data, hydrated]);

  const current =
    typeof data?.publicUrl === "string" ? (data.publicUrl as string) : "";
  const dirty = draft.trim() !== current;

  const submit = async () => {
    try {
      await update.mutateAsync({ ...data, publicUrl: draft.trim() });
      toast.success(draft.trim() ? "public URL saved" : "public URL cleared");
    } catch (e) {
      toast.error("save failed", (e as Error).message);
    }
  };

  return (
    <section className="rounded-sm border border-border bg-surface p-5">
      <div className="mb-1 flex items-center gap-2">
        <Globe size={14} className="text-accent" />
        <h2 className="font-mono text-small uppercase tracking-wideish text-fg">
          bridge
        </h2>
      </div>
      <p className="mb-4 text-small text-muted">
        the origin the bridge is reachable at after deploy. used to render
        clickable links in webhook payloads.
      </p>

      {isLoading ? (
        <Skeleton className="h-8 w-full rounded-sm" />
      ) : (
        <div className="grid gap-2">
          <Label htmlFor="public-url">public origin</Label>
          <Input
            id="public-url"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="https://bridge.example.com"
            spellCheck={false}
            inputMode="url"
          />
          <p className="text-[11px] text-muted">
            origin only — http:// or https://. path / query / hash get stripped.
          </p>
          <div className="flex items-center gap-2 pt-1">
            <Button
              onClick={() => void submit()}
              disabled={update.isPending || !dirty}
            >
              {update.isPending ? "saving…" : "save"}
            </Button>
            {current && (
              <Button
                variant="ghost"
                onClick={() => {
                  setDraft("");
                }}
                className="text-muted hover:text-status-blocked"
              >
                clear
              </Button>
            )}
          </div>
        </div>
      )}
    </section>
  );
}

/* ─────────────────────── detect ─────────────────────── */

function DetectSection() {
  return (
    <section className="rounded-sm border border-dashed border-border bg-surface/50 p-5">
      <div className="mb-1 flex items-center gap-2">
        <Sparkles size={14} className="text-accent" />
        <h2 className="font-mono text-small uppercase tracking-wideish text-fg">
          scope detection
        </h2>
      </div>
      <p className="text-small text-muted">
        detect source: auto (LLM + heuristic) — controls landing soon. backend{" "}
        <span className="font-mono text-fg">/api/detect/settings</span>{" "}
        endpoint isn&apos;t ported yet.
      </p>
    </section>
  );
}

/* ─────────────────────── apps registry root ─────────────────────── */

function ScanRootsSection() {
  return (
    <section className="rounded-sm border border-dashed border-border bg-surface/50 p-5">
      <div className="mb-1 flex items-center gap-2">
        <FolderTree size={14} className="text-accent" />
        <h2 className="font-mono text-small uppercase tracking-wideish text-fg">
          apps registry root
        </h2>
      </div>
      <p className="text-small text-muted">
        scan-roots editor not yet ported. the auto-detect dialog uses the
        bridge default root for now.
      </p>
    </section>
  );
}

/* ─────────────────────── helpers ─────────────────────── */

function Card({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-sm border border-border bg-bg p-3">
      <div className="font-mono text-[10px] uppercase tracking-wideish text-muted">
        {label}
      </div>
      <div className="mt-1.5 font-mono text-small tabular-nums text-fg">
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
