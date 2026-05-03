import { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Copy,
  Download,
  ExternalLink,
  Eye,
  Globe2,
  Key,
  Pencil,
  Play,
  RotateCw,
  Square,
  Trash2,
} from "lucide-react";
import {
  useInstallNgrok,
  useSetNgrokAuthtoken,
  useStartTunnel,
  useStopTunnel,
  useTunnelProviders,
  useTunnels,
} from "@/api/queries";
import { useToast } from "@/components/Toasts";
import { useConfirm } from "@/components/ConfirmProvider";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { EmptyState } from "@/components/ui/empty-state";
import type {
  TunnelEntry,
  TunnelProvider,
  TunnelProviderStatus,
} from "@/api/types";
import { cn } from "@/lib/cn";

const PROVIDER_LABELS: Record<TunnelProvider, string> = {
  localtunnel: "localtunnel — free, no signup",
  ngrok: "ngrok — faster, needs authtoken",
};

/** Reminder of where the public URL will land. Updates live as the
 *  operator edits the subdomain so they don't have to wait for the
 *  spawn to land before realising they typed `7777` instead of the
 *  intended port. */
const PROVIDER_HOST_HINT: Record<TunnelProvider, string> = {
  localtunnel: "*.loca.lt",
  ngrok: "*.ngrok-free.app",
};

const LOCALTUNNEL_PASSWORD_DOC = "https://loca.lt/mytunnelpassword";
const NGROK_INSPECTOR_URL = "http://localhost:4040";
const NGROK_AUTHTOKEN_DASHBOARD =
  "https://dashboard.ngrok.com/get-started/your-authtoken";

export default function TunnelsPage() {
  const { data: tunnelsData, isLoading } = useTunnels();
  const { data: providersData } = useTunnelProviders();
  const startTunnel = useStartTunnel();
  const stopTunnel = useStopTunnel();
  const toast = useToast();
  const confirm = useConfirm();

  const tunnels = tunnelsData?.tunnels ?? [];
  const providers = providersData?.providers ?? [];
  const ngrok = providers.find((p) => p.provider === "ngrok") ?? null;

  // ----- inline start form state -----
  const [provider, setProvider] = useState<TunnelProvider>("localtunnel");
  const [port, setPort] = useState("3000");
  const [subdomain, setSubdomain] = useState("");
  const [label, setLabel] = useState("");

  const currentProvider = useMemo<TunnelProviderStatus | null>(
    () => providers.find((p) => p.provider === provider) ?? null,
    [providers, provider],
  );
  const ready =
    !currentProvider ||
    (currentProvider.installed &&
      (provider !== "ngrok" || !!currentProvider.authtokenSet));

  /** Tunnel ids we've already toasted "URL ready" for. Without this we'd
   *  re-announce every poll while the row is still running. */
  const announcedRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    for (const row of tunnels) {
      if (row.status === "running" && row.url && !announcedRef.current.has(row.id)) {
        announcedRef.current.add(row.id);
        toast.success(`${row.provider} ready`, row.url);
      }
    }
  }, [tunnels, toast]);

  const live = useMemo(
    () =>
      tunnels.filter(
        (t) => t.status === "running" || t.status === "starting",
      ),
    [tunnels],
  );
  const ended = useMemo(
    () =>
      tunnels.filter((t) => t.status === "stopped" || t.status === "error"),
    [tunnels],
  );

  const submitStart = async () => {
    const p = Number(port);
    if (!Number.isInteger(p) || p < 1 || p > 65535) {
      toast.error("invalid port", "must be 1-65535");
      return;
    }
    if (!ready) {
      toast.error(`${provider} is not ready`, "see status above");
      return;
    }
    try {
      await startTunnel.mutateAsync({
        port: p,
        provider,
        label: label.trim() || undefined,
        subdomain:
          provider === "localtunnel" ? subdomain.trim() || undefined : undefined,
      });
      toast.info(`${provider} starting on :${p}…`);
      setLabel("");
      setSubdomain("");
    } catch (e) {
      toast.error("start failed", (e as Error).message);
    }
  };

  const onStop = async (t: TunnelEntry) => {
    if (live.length === 1 && (t.status === "running" || t.status === "starting")) {
      const ok = await confirm({
        title: "stop the last live tunnel?",
        description:
          "this is the only running tunnel. anyone using this URL will lose access.",
        confirmLabel: "stop",
        variant: "destructive",
      });
      if (!ok) return;
    }
    try {
      await stopTunnel.mutateAsync({ id: t.id });
      toast.info(`stopped ${t.provider} :${t.port}`);
    } catch (e) {
      toast.error("stop failed", (e as Error).message);
    }
  };

  const onRemove = async (t: TunnelEntry) => {
    const ok = await confirm({
      title: "remove tunnel row?",
      description:
        t.status === "running" || t.status === "starting"
          ? "this stops the tunnel and removes the row."
          : "removes the row.",
      confirmLabel: "remove",
      variant: "destructive",
    });
    if (!ok) return;
    try {
      await stopTunnel.mutateAsync({ id: t.id, purge: true });
      announcedRef.current.delete(t.id);
    } catch (e) {
      toast.error("remove failed", (e as Error).message);
    }
  };

  /**
   * Re-spawn an ended row with the same provider + port + label +
   * subdomain. Purge the dead row first so the in-memory cap doesn't
   * leak — main learnt this the hard way (zombies counting against
   * MAX_CONCURRENT). The purge failure is non-fatal.
   */
  const onRestart = async (t: TunnelEntry) => {
    try {
      try {
        await stopTunnel.mutateAsync({ id: t.id, purge: true });
      } catch (purgeErr) {
        console.warn(
          "[tunnels] restart purge failed:",
          (purgeErr as Error).message,
        );
      }
      announcedRef.current.delete(t.id);
      await startTunnel.mutateAsync({
        port: t.port,
        provider: t.provider,
        label: t.label,
        subdomain: t.subdomain,
      });
      toast.info(`restarting ${t.provider} on :${t.port}…`);
    } catch (e) {
      toast.error("restart failed", (e as Error).message);
    }
  };

  const onClearEnded = async () => {
    if (ended.length === 0) return;
    const ok = await confirm({
      title: `clear ${ended.length} ended row${ended.length === 1 ? "" : "s"}?`,
      description:
        "removes stopped and errored tunnels from the list. active rows are unaffected.",
      confirmLabel: "clear",
      variant: "destructive",
    });
    if (!ok) return;
    const results = await Promise.allSettled(
      ended.map((t) => stopTunnel.mutateAsync({ id: t.id, purge: true })),
    );
    const failed = results.filter((r) => r.status === "rejected").length;
    ended.forEach((t) => announcedRef.current.delete(t.id));
    if (failed === 0) {
      toast.info(`cleared ${ended.length} row${ended.length === 1 ? "" : "s"}`);
    } else {
      toast.warning(
        `cleared ${ended.length - failed} of ${ended.length}`,
        `${failed} failed — try again`,
      );
    }
  };

  return (
    <div className="mx-auto w-full max-w-3xl p-4 sm:p-6 space-y-5 sm:space-y-6">
      <div className="flex items-center gap-2 mb-2">
        <Globe2 size={18} className="text-primary" />
        <h2 className="text-base sm:text-lg font-semibold">Tunnels</h2>
      </div>
      <p className="text-[11px] sm:text-xs text-muted-foreground">
        Expose a local port to the public internet. Pick{" "}
        <code className="font-mono text-foreground">localtunnel</code>{" "}
        for a one-click free tunnel, or{" "}
        <code className="font-mono text-foreground">ngrok</code> for a
        faster connection (one-time authtoken setup). Tunnels die when
        the bridge process exits.
      </p>

      {/* Inline start form — primary path. Modal flow is gone; the
          form is always visible above the list. */}
      <section className="rounded-lg border border-border bg-card p-4">
        <div className="mb-3 flex items-center gap-2">
          <Play size={14} className="text-primary" />
          <h3 className="text-[13px] sm:text-sm font-semibold">Start a tunnel</h3>
        </div>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (!startTunnel.isPending && ready) void submitStart();
          }}
          className="space-y-3"
        >
          <div className="grid gap-3 sm:grid-cols-2 sm:items-start">
            <div className="grid gap-1.5">
              <Label htmlFor="tunnel-provider">Provider</Label>
              <Select
                value={provider}
                onValueChange={(v) => setProvider(v as TunnelProvider)}
              >
                <SelectTrigger id="tunnel-provider">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="localtunnel">
                    {PROVIDER_LABELS.localtunnel}
                  </SelectItem>
                  <SelectItem value="ngrok">{PROVIDER_LABELS.ngrok}</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="tunnel-port">Port</Label>
              <Input
                id="tunnel-port"
                value={port}
                onChange={(e) =>
                  setPort(e.target.value.replace(/[^\d]/g, ""))
                }
                inputMode="numeric"
                placeholder="3000"
                autoComplete="off"
              />
              <div className="flex flex-wrap gap-1.5 text-[11px]">
                <PortChip value="7777" label="bridge" onPick={setPort} />
                <PortChip value="3000" label="next" onPick={setPort} />
              </div>
            </div>
          </div>

          <div className="grid gap-3 sm:grid-cols-2 sm:items-start">
            <div className="grid gap-1.5">
              <Label htmlFor="tunnel-subdomain">
                Subdomain{" "}
                <span className="text-muted-foreground">
                  {provider === "localtunnel"
                    ? "(optional)"
                    : "(paid plan only)"}
                </span>
              </Label>
              <Input
                id="tunnel-subdomain"
                value={subdomain}
                onChange={(e) =>
                  setSubdomain(
                    e.target.value
                      .toLowerCase()
                      .replace(/[^a-z0-9-]/g, ""),
                  )
                }
                placeholder={provider === "localtunnel" ? "my-bridge" : "n/a"}
                autoComplete="off"
                spellCheck={false}
                disabled={provider !== "localtunnel"}
              />
              <p className="text-[11px] text-muted-foreground sm:min-h-[2.6em] leading-snug">
                {provider === "localtunnel"
                  ? "Sticky URL across restarts. 4–63 chars, lowercase + digits + hyphens."
                  : "ngrok free-plan subdomains are randomized."}
              </p>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="tunnel-label">
                Label <span className="text-muted-foreground">(optional)</span>
              </Label>
              <Input
                id="tunnel-label"
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                placeholder="landing demo"
                autoComplete="off"
              />
              <p className="text-[11px] text-muted-foreground sm:min-h-[2.6em] leading-snug">
                Shows in the row so you can tell parallel tunnels apart.
              </p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2 pt-1">
            <span className="text-[11px] text-muted-foreground">
              URL host:{" "}
              <code className="font-mono text-foreground">
                {provider === "localtunnel" && subdomain.trim()
                  ? `${subdomain.trim()}.loca.lt`
                  : PROVIDER_HOST_HINT[provider]}
              </code>
            </span>
            <div className="flex-1" />
            <Button
              type="submit"
              disabled={startTunnel.isPending || !ready}
            >
              <Play size={12} />
              {startTunnel.isPending ? "Starting…" : "Start tunnel"}
            </Button>
          </div>
        </form>

        <p className="mt-3 border-t border-border pt-3 text-[11px] text-muted-foreground">
          ⚠ Anyone with the URL can reach the port — don&apos;t expose
          services without auth.
          {provider === "localtunnel" && (
            <>
              {" "}localtunnel shows an interstitial on first visit asking
              for the &ldquo;tunnel password&rdquo; = your machine&apos;s
              public IP. Click{" "}
              <a
                href={LOCALTUNNEL_PASSWORD_DOC}
                target="_blank"
                rel="noreferrer"
                className="text-primary underline-offset-2 hover:underline"
              >
                loca.lt/mytunnelpassword
              </a>
              {" "}to fetch yours.
            </>
          )}
        </p>
      </section>

      {provider === "ngrok" && ngrok && <NgrokStatusPanel status={ngrok} />}

      {isLoading ? (
        <p className="text-xs text-muted-foreground">Loading tunnels…</p>
      ) : tunnels.length === 0 ? (
        <EmptyState
          icon={Globe2}
          title="No tunnels yet"
          hint="Start one above to share a local port over the public internet."
        />
      ) : (
        <div className="space-y-6">
          {live.length > 0 && (
            <section>
              <h3 className="mb-2 text-[13px] sm:text-sm font-semibold">
                Active ({live.length})
              </h3>
              <div className="space-y-2">
                {live.map((t) => (
                  <TunnelRow
                    key={t.id}
                    t={t}
                    onStop={() => void onStop(t)}
                    onRestart={() => void onRestart(t)}
                    onRemove={() => void onRemove(t)}
                  />
                ))}
              </div>
            </section>
          )}
          {ended.length > 0 && (
            <section>
              <div className="mb-2 flex items-center gap-2">
                <h3 className="text-[13px] sm:text-sm font-semibold">
                  Ended ({ended.length})
                </h3>
                <div className="flex-1" />
                <Button
                  variant="ghost"
                  size="xs"
                  onClick={() => void onClearEnded()}
                  className="text-fg-dim hover:text-destructive"
                >
                  <Trash2 size={11} />
                  Clear all
                </Button>
              </div>
              <div className="space-y-2">
                {ended.map((t) => (
                  <TunnelRow
                    key={t.id}
                    t={t}
                    onStop={() => void onStop(t)}
                    onRestart={() => void onRestart(t)}
                    onRemove={() => void onRemove(t)}
                  />
                ))}
              </div>
            </section>
          )}
        </div>
      )}
    </div>
  );
}

function PortChip({
  value,
  label,
  onPick,
}: {
  value: string;
  label: string;
  onPick: (v: string) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onPick(value)}
      className="rounded bg-secondary px-1.5 py-0.5 font-mono text-foreground hover:bg-accent"
    >
      {value} {label}
    </button>
  );
}

/* ─────────────────────── ngrok status ─────────────────────── */

/**
 * Three states:
 *   - not installed → install button (or manual link) + log preview
 *   - installed without authtoken → input + save
 *   - ready → masked status + edit/replace/clear actions
 *
 * "Clear" calls setNgrokAuthtoken("") — the Go handler stores the
 * empty value, which the providers query then reflects as
 * `authtokenSet=false` so the panel flips back to the input state.
 */
function NgrokStatusPanel({ status }: { status: TunnelProviderStatus }) {
  const installNgrok = useInstallNgrok();
  const setAuth = useSetNgrokAuthtoken();
  const toast = useToast();
  const [token, setToken] = useState("");
  const [editing, setEditing] = useState(false);
  const [installLog, setInstallLog] = useState<string | null>(null);

  const showInput = !status.authtokenSet || editing;

  if (!status.installed) {
    return (
      <section className="rounded-lg border border-warning/30 bg-warning/5 p-4">
        <div className="mb-2 flex items-center gap-2">
          <AlertTriangle size={14} className="text-warning" />
          <h3 className="text-[13px] sm:text-sm font-semibold">ngrok not installed</h3>
        </div>
        <p className="mb-3 text-[11px] text-muted-foreground">
          {status.hint ?? ""}
        </p>
        <div className="flex flex-wrap gap-2">
          {status.installable ? (
            <Button
              onClick={() =>
                installNgrok.mutate(undefined, {
                  onSuccess: (r) => {
                    setInstallLog(r.log ?? null);
                    if (r.ok) toast.success("ngrok installed");
                    else toast.error("ngrok install failed", "see log");
                  },
                  onError: (e) =>
                    toast.error("install failed", (e as Error).message),
                })
              }
              disabled={installNgrok.isPending}
            >
              <Download size={12} />
              {installNgrok.isPending
                ? "Installing… (1–2 min)"
                : "Install ngrok"}
            </Button>
          ) : (
            <Button asChild variant="outline">
              <a
                href="https://ngrok.com/download"
                target="_blank"
                rel="noreferrer"
              >
                <ExternalLink size={12} />
                Download manually
              </a>
            </Button>
          )}
        </div>
        {installLog && (
          <pre className="mt-3 max-h-48 overflow-auto rounded bg-secondary p-2 font-mono text-[11px] text-muted-foreground whitespace-pre-wrap break-all">
            {installLog}
          </pre>
        )}
      </section>
    );
  }

  if (showInput) {
    return (
      <section className="rounded-lg border border-warning/30 bg-warning/5 p-4">
        <div className="mb-2 flex items-center gap-2">
          <Key size={14} className="text-warning" />
          <h3 className="text-[13px] sm:text-sm font-semibold">
            {status.authtokenSet
              ? "Replace ngrok authtoken"
              : "ngrok authtoken needed"}
          </h3>
        </div>
        <p className="mb-3 text-[11px] text-muted-foreground">
          Get your token from{" "}
          <a
            href={NGROK_AUTHTOKEN_DASHBOARD}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 text-primary underline-offset-2 hover:underline"
          >
            dashboard.ngrok.com
            <ExternalLink size={10} />
          </a>
          {" "}— free signup, takes a minute. Saved to{" "}
          <code className="font-mono">~/.claude/bridge.json</code> with mode 0600.
        </p>
        <div className="flex flex-wrap items-end gap-2">
          <div className="grid min-w-[260px] flex-1 gap-1.5">
            <Label htmlFor="ngrok-token">Authtoken</Label>
            <Input
              id="ngrok-token"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              type="password"
              placeholder="2abcd…XYZ"
              spellCheck={false}
              autoComplete="off"
            />
          </div>
          <Button
            onClick={() =>
              setAuth.mutate(token.trim(), {
                onSuccess: () => {
                  setToken("");
                  setEditing(false);
                  toast.success("authtoken saved");
                },
                onError: (e) =>
                  toast.error("save failed", (e as Error).message),
              })
            }
            disabled={setAuth.isPending || !token.trim()}
          >
            {setAuth.isPending ? "Saving…" : "Save"}
          </Button>
          {status.authtokenSet && (
            <Button
              variant="ghost"
              onClick={() => {
                setEditing(false);
                setToken("");
              }}
              className="text-fg-dim"
            >
              Cancel
            </Button>
          )}
        </div>
      </section>
    );
  }

  return (
    <section className="rounded-lg border border-success/30 bg-success/5 p-3">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <CheckCircle2 size={14} className="text-success" />
        <span className="font-medium">ngrok ready</span>
        {status.version && (
          <span className="text-muted-foreground font-mono text-[11px]">
            v{status.version}
          </span>
        )}
        <span className="text-muted-foreground">· authtoken saved</span>
        <div className="flex-1" />
        <Button
          variant="ghost"
          size="xs"
          onClick={() => setEditing(true)}
          className="text-fg-dim"
        >
          <Pencil size={11} />
          Replace
        </Button>
        <Button
          variant="ghost"
          size="xs"
          onClick={() =>
            setAuth.mutate("", {
              onSuccess: () => toast.info("authtoken cleared"),
              onError: (e) =>
                toast.error("clear failed", (e as Error).message),
            })
          }
          disabled={setAuth.isPending}
          className="text-fg-dim hover:text-destructive"
        >
          <Trash2 size={11} />
          Clear
        </Button>
      </div>
    </section>
  );
}

/* ─────────────────────── tunnel row ─────────────────────── */

function TunnelRow({
  t,
  onStop,
  onRestart,
  onRemove,
}: {
  t: TunnelEntry;
  onStop: () => void;
  onRestart: () => void;
  onRemove: () => void;
}) {
  const toast = useToast();
  const [copied, setCopied] = useState(false);
  const [showLog, setShowLog] = useState(false);
  const live = t.status === "running" || t.status === "starting";
  const canRestart = t.status === "stopped" || t.status === "error";
  const logLines = t.log ?? [];

  const copy = async () => {
    if (!t.url) return;
    try {
      await navigator.clipboard.writeText(t.url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error("copy failed");
    }
  };

  const uptime = useMemo(() => {
    if (!t.startedAt) return "—";
    const start = Date.parse(t.startedAt);
    if (!Number.isFinite(start)) return "—";
    const end = t.endedAt ? Date.parse(t.endedAt) : Date.now();
    const sec = Math.max(0, Math.floor((end - start) / 1000));
    if (sec < 60) return `${sec}s`;
    const m = Math.floor(sec / 60);
    if (m < 60) return `${m}m`;
    const h = Math.floor(m / 60);
    return `${h}h ${m % 60}m`;
  }, [t.startedAt, t.endedAt]);

  return (
    <div
      className={cn(
        "rounded-lg border bg-card p-3 transition-colors",
        t.status === "running"
          ? "border-success/30"
          : t.status === "error"
            ? "border-destructive/30"
            : "border-border",
      )}
    >
      <div className="flex flex-wrap items-center gap-2">
        <StatusPill status={t.status} />
        <span className="rounded bg-secondary px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wide text-muted-foreground">
          {t.provider}
        </span>
        <span className="font-mono text-sm text-foreground">:{t.port}</span>
        {t.subdomain && (
          <span className="font-mono text-[11px] text-muted-foreground">
            ↗ {t.subdomain}
          </span>
        )}
        {t.label && (
          <span className="text-xs text-muted-foreground truncate">
            — {t.label}
          </span>
        )}
        <span className="ml-auto font-mono text-[10px] uppercase tracking-wide text-muted-foreground">
          uptime {uptime}
        </span>
        {live && (
          <Button
            variant="ghost"
            size="xs"
            onClick={onStop}
            title="Stop tunnel"
            aria-label="Stop tunnel"
            className="text-fg-dim hover:text-destructive"
          >
            <Square size={11} />
            <span className="hidden sm:inline">Stop</span>
          </Button>
        )}
        {canRestart && (
          <Button
            variant="ghost"
            size="xs"
            onClick={onRestart}
            title="Restart tunnel"
            aria-label="Restart tunnel"
            className="text-fg-dim hover:text-foreground"
          >
            <RotateCw size={11} />
            <span className="hidden sm:inline">Restart</span>
          </Button>
        )}
        <Button
          variant="ghost"
          size="xs"
          onClick={onRemove}
          title="Remove tunnel"
          aria-label="Remove tunnel"
          className="text-fg-dim hover:text-destructive"
        >
          <Trash2 size={11} />
          <span className="hidden sm:inline">Remove</span>
        </Button>
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-2">
        {t.url ? (
          <>
            <a
              href={t.url}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 break-all font-mono text-sm text-primary underline-offset-2 hover:underline"
            >
              {t.url}
              <ExternalLink size={11} />
            </a>
            <Button variant="ghost" size="xs" onClick={() => void copy()}>
              <Copy size={11} />
              <span className="hidden sm:inline">{copied ? "Copied" : "Copy"}</span>
            </Button>
            {t.provider === "ngrok" && live && (
              <Button asChild variant="ghost" size="xs" className="text-fg-dim">
                <a
                  href={NGROK_INSPECTOR_URL}
                  target="_blank"
                  rel="noreferrer"
                  title="ngrok web inspector"
                  aria-label="ngrok web inspector"
                >
                  <Eye size={11} />
                  <span className="hidden sm:inline">Inspect</span>
                </a>
              </Button>
            )}
          </>
        ) : t.status === "starting" ? (
          <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-warning" />
            Waiting for URL…
          </span>
        ) : (
          <span className="text-xs text-muted-foreground">No URL</span>
        )}
      </div>

      {t.error && (
        <p className="mt-2 break-all text-xs text-destructive">
          {t.error}
        </p>
      )}

      <div className="mt-2 flex items-center gap-3 text-[11px] text-muted-foreground">
        {t.startedAt && (
          <span>Started {new Date(t.startedAt).toLocaleTimeString()}</span>
        )}
        {t.endedAt && (
          <span>· Ended {new Date(t.endedAt).toLocaleTimeString()}</span>
        )}
        {logLines.length > 0 && (
          <button
            type="button"
            onClick={() => setShowLog((v) => !v)}
            className="underline-offset-2 hover:underline"
          >
            {showLog ? "Hide log" : `Show log (${logLines.length})`}
          </button>
        )}
      </div>

      {showLog && logLines.length > 0 && (
        <pre className="mt-2 max-h-40 overflow-auto rounded bg-secondary p-2 font-mono text-[11px] text-muted-foreground whitespace-pre-wrap break-all">
          {logLines.join("\n")}
        </pre>
      )}
    </div>
  );
}

function StatusPill({ status }: { status: TunnelEntry["status"] }) {
  const map: Record<TunnelEntry["status"], { label: string; cls: string }> = {
    starting: {
      label: "starting",
      cls: "bg-warning/15 text-warning-foreground animate-pulse",
    },
    running: {
      label: "running",
      cls: "bg-success/15 text-success-foreground",
    },
    stopped: {
      label: "stopped",
      cls: "bg-secondary text-muted-foreground",
    },
    error: {
      label: "error",
      cls: "bg-destructive/15 text-destructive",
    },
  };
  const { label, cls } = map[status];
  return (
    <span
      className={cn(
        "rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wide font-medium",
        cls,
      )}
    >
      {label}
    </span>
  );
}
