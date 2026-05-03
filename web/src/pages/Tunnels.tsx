import { useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Copy,
  Download,
  ExternalLink,
  Globe2,
  Key,
  Plus,
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
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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
const NGROK_AUTHTOKEN_DASHBOARD =
  "https://dashboard.ngrok.com/get-started/your-authtoken";

export default function TunnelsPage() {
  const { data: tunnelsData, isLoading } = useTunnels();
  const { data: providersData } = useTunnelProviders();
  const stopTunnel = useStopTunnel();
  const toast = useToast();
  const confirm = useConfirm();

  const [startOpen, setStartOpen] = useState(false);

  const tunnels = tunnelsData?.tunnels ?? [];
  const providers = providersData?.providers ?? [];
  const ngrok = providers.find((p) => p.provider === "ngrok") ?? null;

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
    } catch (e) {
      toast.error("remove failed", (e as Error).message);
    }
  };

  return (
    <div className="mx-auto w-full max-w-3xl px-6 py-10">
      <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <Globe2 size={18} className="text-accent" />
            <h1 className="font-mono text-display font-semibold tracking-tightish text-fg">
              tunnels
            </h1>
            <span className="font-mono text-micro uppercase tracking-wideish text-muted">
              {tunnels.length} row{tunnels.length === 1 ? "" : "s"}
            </span>
          </div>
          <p className="mt-2 max-w-xl text-small text-muted">
            expose a local port to the public internet. tunnels die when the
            bridge process exits.
          </p>
        </div>
        <Button onClick={() => setStartOpen(true)}>
          <Plus size={12} />
          start tunnel
        </Button>
      </div>

      {ngrok && <NgrokStatusPanel status={ngrok} />}

      {isLoading ? (
        <p className="font-mono text-micro tracking-wideish text-muted">
          loading tunnels…
        </p>
      ) : tunnels.length === 0 ? (
        <EmptyState
          icon={Globe2}
          title="no tunnels yet"
          hint="start one above to share a local port over the public internet."
        />
      ) : (
        <div className="space-y-6">
          {live.length > 0 && (
            <section>
              <h3 className="mb-2 font-mono text-micro uppercase tracking-wideish text-muted">
                active ({live.length})
              </h3>
              <div className="space-y-2">
                {live.map((t) => (
                  <TunnelRow
                    key={t.id}
                    t={t}
                    onStop={() => void onStop(t)}
                    onRemove={() => void onRemove(t)}
                  />
                ))}
              </div>
            </section>
          )}
          {ended.length > 0 && (
            <section>
              <h3 className="mb-2 font-mono text-micro uppercase tracking-wideish text-muted">
                ended ({ended.length})
              </h3>
              <div className="space-y-2">
                {ended.map((t) => (
                  <TunnelRow
                    key={t.id}
                    t={t}
                    onStop={() => void onStop(t)}
                    onRemove={() => void onRemove(t)}
                  />
                ))}
              </div>
            </section>
          )}
        </div>
      )}

      <StartTunnelDialog
        open={startOpen}
        onOpenChange={setStartOpen}
        ngrokReady={!!ngrok?.installed && !!ngrok?.authtokenSet}
      />
    </div>
  );
}

/* ─────────────────────── start dialog ─────────────────────── */

function StartTunnelDialog({
  open,
  onOpenChange,
  ngrokReady,
}: {
  open: boolean;
  onOpenChange: (next: boolean) => void;
  ngrokReady: boolean;
}) {
  const startTunnel = useStartTunnel();
  const toast = useToast();
  const [provider, setProvider] = useState<TunnelProvider>("localtunnel");
  const [port, setPort] = useState("7777");
  const [subdomain, setSubdomain] = useState("");
  const [label, setLabel] = useState("");

  useEffect(() => {
    if (!open) {
      setProvider("localtunnel");
      setPort("7777");
      setSubdomain("");
      setLabel("");
    }
  }, [open]);

  const submit = async () => {
    const p = Number(port);
    if (!Number.isInteger(p) || p < 1 || p > 65535) {
      toast.error("invalid port", "must be 1-65535");
      return;
    }
    if (provider === "ngrok" && !ngrokReady) {
      toast.error("ngrok not ready", "install + authtoken required");
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
      onOpenChange(false);
    } catch (e) {
      toast.error("start failed", (e as Error).message);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>start tunnel</DialogTitle>
          <DialogDescription>
            spawn a public tunnel for a local port.
          </DialogDescription>
        </DialogHeader>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
          className="grid gap-3"
        >
          <div className="grid gap-1.5">
            <Label htmlFor="t-provider">provider</Label>
            <Select
              value={provider}
              onValueChange={(v) => setProvider(v as TunnelProvider)}
            >
              <SelectTrigger id="t-provider">
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
            <Label htmlFor="t-port">port</Label>
            <Input
              id="t-port"
              value={port}
              onChange={(e) => setPort(e.target.value.replace(/[^\d]/g, ""))}
              inputMode="numeric"
              placeholder="7777"
            />
          </div>

          {provider === "localtunnel" && (
            <div className="grid gap-1.5">
              <Label htmlFor="t-subdomain">subdomain (optional)</Label>
              <Input
                id="t-subdomain"
                value={subdomain}
                onChange={(e) =>
                  setSubdomain(
                    e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ""),
                  )
                }
                placeholder="my-bridge"
                spellCheck={false}
              />
            </div>
          )}

          <div className="grid gap-1.5">
            <Label htmlFor="t-label">label (optional)</Label>
            <Input
              id="t-label"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="landing demo"
            />
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={() => onOpenChange(false)}
              disabled={startTunnel.isPending}
            >
              cancel
            </Button>
            <Button type="submit" disabled={startTunnel.isPending}>
              {startTunnel.isPending ? "starting…" : "start"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/* ─────────────────────── ngrok status ─────────────────────── */

function NgrokStatusPanel({ status }: { status: TunnelProviderStatus }) {
  const installNgrok = useInstallNgrok();
  const setAuth = useSetNgrokAuthtoken();
  const toast = useToast();
  const [token, setToken] = useState("");

  if (!status.installed) {
    return (
      <section className="mb-6 rounded-sm border border-status-doing/40 bg-status-doing/5 p-3">
        <div className="mb-1 flex items-center gap-2">
          <AlertTriangle size={14} className="text-status-doing" />
          <span className="font-mono text-micro uppercase tracking-wideish text-fg">
            ngrok not installed
          </span>
        </div>
        <p className="mb-3 text-[11px] text-muted">{status.hint ?? ""}</p>
        <div className="flex gap-2">
          {status.installable ? (
            <Button
              onClick={() =>
                installNgrok.mutate(undefined, {
                  onSuccess: () => toast.success("ngrok installed"),
                  onError: (e) =>
                    toast.error("install failed", (e as Error).message),
                })
              }
              disabled={installNgrok.isPending}
            >
              <Download size={12} />
              {installNgrok.isPending ? "installing…" : "install ngrok"}
            </Button>
          ) : (
            <Button asChild variant="outline">
              <a
                href="https://ngrok.com/download"
                target="_blank"
                rel="noreferrer"
              >
                <ExternalLink size={12} />
                download manually
              </a>
            </Button>
          )}
        </div>
      </section>
    );
  }

  if (!status.authtokenSet) {
    return (
      <section className="mb-6 rounded-sm border border-status-doing/40 bg-status-doing/5 p-3">
        <div className="mb-1 flex items-center gap-2">
          <Key size={14} className="text-status-doing" />
          <span className="font-mono text-micro uppercase tracking-wideish text-fg">
            ngrok authtoken needed
          </span>
        </div>
        <p className="mb-3 text-[11px] text-muted">
          get your token from{" "}
          <a
            href={NGROK_AUTHTOKEN_DASHBOARD}
            target="_blank"
            rel="noreferrer"
            className="text-accent underline-offset-2 hover:underline"
          >
            dashboard.ngrok.com
          </a>
          .
        </p>
        <div className="flex flex-wrap items-end gap-2">
          <div className="grid min-w-[260px] flex-1 gap-1.5">
            <Label htmlFor="ngrok-token">authtoken</Label>
            <Input
              id="ngrok-token"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              type="password"
              placeholder="2abcd…XYZ"
              spellCheck={false}
            />
          </div>
          <Button
            onClick={() =>
              setAuth.mutate(token.trim(), {
                onSuccess: () => {
                  setToken("");
                  toast.success("authtoken saved");
                },
                onError: (e) =>
                  toast.error("save failed", (e as Error).message),
              })
            }
            disabled={setAuth.isPending || !token.trim()}
          >
            {setAuth.isPending ? "saving…" : "save"}
          </Button>
        </div>
      </section>
    );
  }

  return (
    <section className="mb-6 rounded-sm border border-status-done/30 bg-status-done/5 p-3">
      <div className="flex flex-wrap items-center gap-2 text-[11px]">
        <CheckCircle2 size={14} className="text-status-done" />
        <span className="font-mono uppercase tracking-wideish text-fg">
          ngrok ready
        </span>
        {status.version && (
          <span className="font-mono text-muted">v{status.version}</span>
        )}
        <span className="text-muted">· authtoken saved</span>
      </div>
    </section>
  );
}

/* ─────────────────────── tunnel row ─────────────────────── */

function TunnelRow({
  t,
  onStop,
  onRemove,
}: {
  t: TunnelEntry;
  onStop: () => void;
  onRemove: () => void;
}) {
  const toast = useToast();
  const [copied, setCopied] = useState(false);
  const live = t.status === "running" || t.status === "starting";

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
        "rounded-sm border bg-surface p-3 transition-colors",
        t.status === "running"
          ? "border-status-done/30"
          : t.status === "error"
            ? "border-status-blocked/30"
            : "border-border",
      )}
    >
      <div className="flex flex-wrap items-center gap-2">
        <StatusPill status={t.status} />
        <span className="rounded-sm bg-bg px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wideish text-muted">
          {t.provider}
        </span>
        <span className="font-mono text-sm text-fg">:{t.port}</span>
        {t.label && (
          <span className="text-small text-muted truncate">— {t.label}</span>
        )}
        <span className="ml-auto font-mono text-[10px] uppercase tracking-wideish text-muted">
          uptime {uptime}
        </span>
        {live && (
          <Button
            variant="ghost"
            size="xs"
            onClick={onStop}
            className="text-muted hover:text-status-blocked"
          >
            <Square size={11} />
            stop
          </Button>
        )}
        <Button
          variant="ghost"
          size="xs"
          onClick={onRemove}
          className="text-muted hover:text-status-blocked"
        >
          <Trash2 size={11} />
          remove
        </Button>
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-2">
        {t.url ? (
          <>
            <a
              href={t.url}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 break-all font-mono text-sm text-accent underline-offset-2 hover:underline"
            >
              {t.url}
              <ExternalLink size={11} />
            </a>
            <Button variant="ghost" size="xs" onClick={() => void copy()}>
              <Copy size={11} />
              {copied ? "copied" : "copy"}
            </Button>
          </>
        ) : t.status === "starting" ? (
          <span className="inline-flex items-center gap-1.5 text-small text-muted">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-status-doing" />
            waiting for URL…
          </span>
        ) : (
          <span className="text-small text-muted">no URL</span>
        )}
      </div>

      {t.error && (
        <p className="mt-2 break-all font-mono text-[11px] text-status-blocked">
          {t.error}
        </p>
      )}
    </div>
  );
}

function StatusPill({ status }: { status: TunnelEntry["status"] }) {
  const map: Record<TunnelEntry["status"], { label: string; cls: string }> = {
    starting: {
      label: "starting",
      cls: "bg-status-doing/15 text-status-doing animate-pulse",
    },
    running: {
      label: "running",
      cls: "bg-status-done/15 text-status-done",
    },
    stopped: {
      label: "stopped",
      cls: "bg-surface-2 text-muted",
    },
    error: {
      label: "error",
      cls: "bg-status-blocked/15 text-status-blocked",
    },
  };
  const { label, cls } = map[status];
  return (
    <span
      className={cn(
        "rounded-sm px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wideish",
        cls,
      )}
    >
      {label}
    </span>
  );
}
