"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import { api } from "@/lib/client/api";
import type {
  TunnelEntry,
  TunnelProvider,
  TunnelProviderStatus,
} from "@/lib/client/types";
import { HeaderShell } from "../_components/HeaderShell";
import { Button } from "../_components/ui/button";
import { Input } from "../_components/ui/input";
import { Label } from "../_components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../_components/ui/select";
import { useToast } from "../_components/Toasts";
import { useConfirm } from "../_components/ConfirmProvider";
import { EmptyState } from "../_components/ui/empty-state";

const PROVIDER_LABELS: Record<TunnelProvider, string> = {
  localtunnel: "localtunnel — free, no signup",
  ngrok: "ngrok — faster, needs authtoken",
};

const PROVIDER_HOST_HINT: Record<TunnelProvider, string> = {
  localtunnel: "*.loca.lt",
  ngrok: "*.ngrok-free.app",
};

const LOCALTUNNEL_PASSWORD_DOC = "https://loca.lt/mytunnelpassword";
const NGROK_INSPECTOR_URL = "http://localhost:4040";
const NGROK_AUTHTOKEN_DASHBOARD =
  "https://dashboard.ngrok.com/get-started/your-authtoken";

/**
 * Dev-time public tunnels page. Spawn a tunnel client (localtunnel or
 * ngrok) for any local port and watch its public URL appear in the row.
 * Tunnels are in-memory only — every entry dies when the bridge process
 * exits. The provider Select drives both the spawn command and the
 * accompanying readiness panel (install + authtoken affordances for
 * ngrok). Restarting an ended row, clearing the Ended bucket, copying
 * URLs, and opening the ngrok inspector all happen inline — there's no
 * scenario where the operator has to drop to a terminal.
 */
function TunnelsPage() {
  const [tunnels, setTunnels] = useState<TunnelEntry[]>([]);
  const [providers, setProviders] = useState<TunnelProviderStatus[]>([]);
  const [loading, setLoading] = useState(true);
  const [provider, setProvider] = useState<TunnelProvider>("localtunnel");
  const [port, setPort] = useState("3000");
  const [label, setLabel] = useState("");
  const [subdomain, setSubdomain] = useState("");
  const [starting, setStarting] = useState(false);
  const toast = useToast();
  const confirm = useConfirm();
  /**
   * Tunnel ids we've already toasted "URL ready" for. Without this we'd
   * re-announce on every poll while the row is still running.
   */
  const announcedRef = useRef<Set<string>>(new Set());

  const refresh = useCallback(async () => {
    try {
      const [t, p] = await Promise.all([api.tunnels(), api.tunnelProviders()]);
      // Detect starting → running transitions and announce them once.
      for (const row of t.tunnels) {
        if (row.status === "running" && row.url && !announcedRef.current.has(row.id)) {
          announcedRef.current.add(row.id);
          toast("success", `${row.provider} ready — ${row.url}`);
        }
      }
      setTunnels(t.tunnels);
      setProviders(p.providers);
    } catch (e) {
      toast("error", (e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    void Promise.resolve().then(refresh);
  }, [refresh]);

  // Fast poll while any tunnel is in `starting` (we're waiting for the
  // URL to land); slow poll otherwise to keep the row count fresh.
  // The `cancelled` flag closes the gap where `refresh()` was already
  // in-flight at unmount: cleanup-only-on-clearTimeout would still let
  // the in-flight promise schedule the next tick after the component
  // had been torn down.
  const tunnelsRef = useRef(tunnels);
  useEffect(() => { tunnelsRef.current = tunnels; }, [tunnels]);
  useEffect(() => {
    let cancelled = false;
    let h: ReturnType<typeof setTimeout> | null = null;
    const tick = async () => {
      if (cancelled) return;
      const anyStarting = tunnelsRef.current.some((t) => t.status === "starting");
      await refresh();
      if (cancelled) return;
      h = setTimeout(() => { void tick(); }, anyStarting ? 1_000 : 4_000);
    };
    h = setTimeout(() => { void tick(); }, 2_000);
    return () => {
      cancelled = true;
      if (h) clearTimeout(h);
    };
  }, [refresh]);

  const currentProvider = useMemo<TunnelProviderStatus | null>(
    () => providers.find((p) => p.provider === provider) ?? null,
    [providers, provider],
  );
  const ngrokStatus = useMemo<TunnelProviderStatus | null>(
    () => providers.find((p) => p.provider === "ngrok") ?? null,
    [providers],
  );
  const ready =
    !currentProvider ||
    (currentProvider.installed && (provider !== "ngrok" || !!currentProvider.authtokenSet));

  const start = async () => {
    const p = Number(port);
    if (!Number.isInteger(p) || p < 1 || p > 65535) {
      toast("error", "Port must be 1-65535");
      return;
    }
    if (!ready) {
      toast("error", `${provider} is not ready — see status above`);
      return;
    }
    setStarting(true);
    try {
      const r = await api.startTunnel({
        port: p,
        provider,
        label: label.trim() || undefined,
        subdomain: provider === "localtunnel" ? subdomain.trim() || undefined : undefined,
      });
      setTunnels((prev) => [r.tunnel, ...prev.filter((t) => t.id !== r.tunnel.id)]);
      setLabel("");
      setSubdomain("");
      toast("info", `${provider} starting for port ${p} — waiting for URL…`);
    } catch (e) {
      toast("error", (e as Error).message);
    } finally {
      setStarting(false);
    }
  };

  const stop = async (t: TunnelEntry) => {
    try {
      await api.stopTunnel(t.id);
      void refresh();
    } catch (e) {
      toast("error", (e as Error).message);
    }
  };

  const remove = async (t: TunnelEntry) => {
    const ok = await confirm({
      title: "Remove tunnel row?",
      description:
        t.status === "running" || t.status === "starting"
          ? "This stops the tunnel and removes the row from the list."
          : "Removes the row from the list.",
      confirmLabel: "Remove",
      destructive: true,
    });
    if (!ok) return;
    try {
      await api.stopTunnel(t.id, true);
      announcedRef.current.delete(t.id);
      setTunnels((prev) => prev.filter((x) => x.id !== t.id));
    } catch (e) {
      toast("error", (e as Error).message);
    }
  };

  /**
   * Re-spawn a stopped/error tunnel with the same provider + port +
   * label + subdomain. We purge the old row server-side BEFORE
   * starting the new one, otherwise a transient DELETE failure left
   * the old entry counting against `MAX_CONCURRENT` (8) — the new
   * spawn would later fail with `max … reached` and the operator had
   * no way to clear the zombie short of a full bridge restart.
   */
  const restart = async (t: TunnelEntry) => {
    try {
      try {
        await api.stopTunnel(t.id, true);
      } catch (purgeErr) {
        // Surface but don't abort — the operator's intent is "give me
        // a working tunnel for this port"; if the old row is already
        // gone server-side that error is benign. We log to console so
        // a real failure (e.g. backend down) leaves a breadcrumb.
        console.warn("[tunnels] restart purge failed:", (purgeErr as Error).message);
      }
      announcedRef.current.delete(t.id);
      const r = await api.startTunnel({
        port: t.port,
        provider: t.provider,
        label: t.label,
        subdomain: t.subdomain,
      });
      setTunnels((prev) => [
        r.tunnel,
        ...prev.filter((x) => x.id !== t.id && x.id !== r.tunnel.id),
      ]);
      toast("info", `Restarting ${t.provider} on port ${t.port}…`);
    } catch (e) {
      toast("error", (e as Error).message);
    }
  };

  const live = useMemo(
    () => tunnels.filter((t) => t.status === "running" || t.status === "starting"),
    [tunnels],
  );
  const ended = useMemo(
    () => tunnels.filter((t) => t.status === "stopped" || t.status === "error"),
    [tunnels],
  );

  const clearEnded = async () => {
    const ids = ended.map((t) => t.id);
    if (ids.length === 0) return;
    const ok = await confirm({
      title: `Clear ${ids.length} ended row${ids.length === 1 ? "" : "s"}?`,
      description: "Removes stopped and errored tunnels from the list. Active rows are unaffected.",
      confirmLabel: "Clear",
      destructive: true,
    });
    if (!ok) return;
    try {
      await Promise.all(ids.map((id) => api.stopTunnel(id, true).catch(() => null)));
      ids.forEach((id) => announcedRef.current.delete(id));
      setTunnels((prev) => prev.filter((x) => !ids.includes(x.id)));
    } catch (e) {
      toast("error", (e as Error).message);
    }
  };

  return (
    <div className="flex flex-col h-screen">
      <HeaderShell active="tunnels" />
      <main className="flex-1 overflow-y-auto">
        <div className="p-6 max-w-3xl mx-auto space-y-6">
          <div className="flex items-center gap-2 mb-2">
            <Globe2 size={18} className="text-primary" />
            <h2 className="text-lg font-semibold">Tunnels</h2>
          </div>
          <p className="text-xs text-muted-foreground mt-4">
            Expose a local port to the public internet. Pick{" "}
            <code className="font-mono text-foreground">localtunnel</code>{" "}
            for a one-click free tunnel, or{" "}
            <code className="font-mono text-foreground">ngrok</code> for a
            faster connection (one-time authtoken setup). Tunnels die when
            the bridge process exits.
          </p>

          <section className="rounded-lg border border-border bg-card p-4">
            <div className="flex items-center gap-2 mb-3">
              <Play size={14} className="text-primary" />
              <h3 className="text-sm font-semibold">Start a tunnel</h3>
            </div>

            <form
              onSubmit={(e) => {
                e.preventDefault();
                if (!starting && ready) void start();
              }}
              className="space-y-3"
            >
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="grid gap-1.5">
                  <Label htmlFor="tunnel-provider">Provider</Label>
                  <Select value={provider} onValueChange={(v) => setProvider(v as TunnelProvider)}>
                    <SelectTrigger id="tunnel-provider">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="localtunnel">{PROVIDER_LABELS.localtunnel}</SelectItem>
                      <SelectItem value="ngrok">{PROVIDER_LABELS.ngrok}</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="grid gap-1.5">
                  <Label htmlFor="tunnel-port">Port</Label>
                  <Input
                    id="tunnel-port"
                    value={port}
                    onChange={(e) => setPort(e.target.value.replace(/[^\d]/g, ""))}
                    inputMode="numeric"
                    placeholder="3000"
                    autoComplete="off"
                  />
                  <div className="flex gap-1.5 text-[11px]">
                    <button
                      type="button"
                      onClick={() => setPort("7777")}
                      className="px-1.5 py-0.5 rounded bg-secondary hover:bg-accent text-foreground font-mono"
                    >
                      7777 bridge
                    </button>
                    <button
                      type="button"
                      onClick={() => setPort("3000")}
                      className="px-1.5 py-0.5 rounded bg-secondary hover:bg-accent text-foreground font-mono"
                    >
                      3000 next
                    </button>
                  </div>
                </div>
              </div>

              <div className="grid gap-3 sm:grid-cols-2">
                <div className="grid gap-1.5">
                  <Label htmlFor="tunnel-subdomain">
                    Subdomain{" "}
                    <span className="text-muted-foreground">
                      {provider === "localtunnel" ? "(optional)" : "(paid plan only)"}
                    </span>
                  </Label>
                  <Input
                    id="tunnel-subdomain"
                    value={subdomain}
                    onChange={(e) =>
                      setSubdomain(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ""))
                    }
                    placeholder={provider === "localtunnel" ? "my-bridge" : "n/a"}
                    autoComplete="off"
                    spellCheck={false}
                    disabled={provider !== "localtunnel"}
                  />
                  <p className="text-[11px] text-muted-foreground">
                    {provider === "localtunnel"
                      ? "Sticky URL across restarts. 4–63 chars, lowercase + digits + hyphens."
                      : "ngrok free-plan subdomains are randomized. Disable to skip."}
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
                    placeholder="e.g. landing demo"
                    autoComplete="off"
                  />
                  <p className="text-[11px] text-muted-foreground">
                    Shows in the row so you can tell parallel tunnels apart.
                  </p>
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-2 pt-1">
                <span className="text-[11px] text-muted-foreground">
                  URL host:{" "}
                  <code className="font-mono text-foreground">
                    {PROVIDER_HOST_HINT[provider]}
                  </code>
                </span>
                <div className="flex-1" />
                <Button type="submit" disabled={starting || !ready}>
                  <Play size={12} />
                  {starting ? "Starting…" : "Start tunnel"}
                </Button>
              </div>
            </form>

            <p className="text-[11px] text-muted-foreground mt-3 pt-3 border-t border-border">
              ⚠ Anyone with the URL can reach the port — don&apos;t expose
              services without auth.
              {provider === "localtunnel" && (
                <>
                  {" "}localtunnel shows an interstitial on first visit asking
                  for the &ldquo;tunnel password&rdquo; = your machine&apos;s public IP.
                  Click{" "}
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

          {provider === "ngrok" && ngrokStatus && (
            <NgrokStatusPanel status={ngrokStatus} onChanged={refresh} />
          )}

          {loading ? (
            <p className="text-xs text-muted-foreground">Loading tunnels…</p>
          ) : tunnels.length === 0 ? (
            <EmptyState
              icon={Globe2}
              title="No tunnels yet"
              hint="Start one above to share a local port over the public internet."
            />
          ) : (
            <>
              {live.length > 0 && (
                <section className="space-y-2">
                  <div className="flex items-center gap-2">
                    <h3 className="text-xs uppercase tracking-wide text-muted-foreground">
                      Active ({live.length})
                    </h3>
                  </div>
                  {live.map((t) => (
                    <TunnelRow
                      key={t.id}
                      t={t}
                      onStop={() => void stop(t)}
                      onRestart={() => void restart(t)}
                      onRemove={() => void remove(t)}
                    />
                  ))}
                </section>
              )}
              {ended.length > 0 && (
                <section className="space-y-2">
                  <div className="flex items-center gap-2">
                    <h3 className="text-xs uppercase tracking-wide text-muted-foreground">
                      Ended ({ended.length})
                    </h3>
                    <div className="flex-1" />
                    <Button
                      variant="ghost"
                      size="xs"
                      onClick={() => void clearEnded()}
                      className="text-fg-dim hover:text-destructive"
                    >
                      <Trash2 size={11} /> Clear all
                    </Button>
                  </div>
                  {ended.map((t) => (
                    <TunnelRow
                      key={t.id}
                      t={t}
                      onStop={() => void stop(t)}
                      onRestart={() => void restart(t)}
                      onRemove={() => void remove(t)}
                    />
                  ))}
                </section>
              )}
            </>
          )}
        </div>
      </main>
    </div>
  );
}

/**
 * ngrok readiness panel. Three states:
 *
 *   - **Not installed** — Install button (cross-platform via the API
 *     route's installerPlan) or a manual-link fallback.
 *   - **Installed but no authtoken** — input + Save. Persists to
 *     `bridge.json#tunnels.ngrok.authtoken` (mode 0600).
 *   - **Ready** — green check + version + collapsed Edit/Clear actions.
 *     Editing flips the row back into the input UI without forcing a
 *     full clear-then-save round-trip.
 */
function NgrokStatusPanel({
  status,
  onChanged,
}: {
  status: TunnelProviderStatus;
  onChanged: () => Promise<void> | void;
}) {
  const [installing, setInstalling] = useState(false);
  const [installLog, setInstallLog] = useState<string | null>(null);
  const [authtoken, setAuthtoken] = useState("");
  const [savingToken, setSavingToken] = useState(false);
  const [editingToken, setEditingToken] = useState(false);
  const toast = useToast();

  const install = async () => {
    setInstalling(true);
    setInstallLog(null);
    try {
      const r = await api.installNgrok();
      setInstallLog(r.log);
      if (r.ok) toast("success", "ngrok installed");
      else toast("error", "ngrok install failed — see log below");
      await onChanged();
    } catch (e) {
      toast("error", (e as Error).message);
    } finally {
      setInstalling(false);
    }
  };

  const saveToken = async () => {
    const v = authtoken.trim();
    if (!v) {
      toast("error", "Paste your authtoken first");
      return;
    }
    setSavingToken(true);
    try {
      await api.setNgrokAuthtoken(v);
      toast("success", "Authtoken saved");
      setAuthtoken("");
      setEditingToken(false);
      await onChanged();
    } catch (e) {
      toast("error", (e as Error).message);
    } finally {
      setSavingToken(false);
    }
  };

  const clearToken = async () => {
    try {
      await api.setNgrokAuthtoken("");
      toast("info", "Authtoken cleared");
      await onChanged();
    } catch (e) {
      toast("error", (e as Error).message);
    }
  };

  if (!status.installed) {
    return (
      <section className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-4">
        <div className="flex items-center gap-2 mb-2">
          <AlertTriangle size={14} className="text-amber-500" />
          <h3 className="text-sm font-semibold">ngrok not installed</h3>
        </div>
        <p className="text-[11px] text-muted-foreground mb-3">{status.hint}</p>
        <div className="flex flex-wrap gap-2">
          {status.installable ? (
            <Button onClick={install} disabled={installing}>
              <Download size={12} />
              {installing ? "Installing… (1–2 min)" : "Install ngrok"}
            </Button>
          ) : (
            <Button asChild variant="outline">
              <a href="https://ngrok.com/download" target="_blank" rel="noreferrer">
                <ExternalLink size={12} /> Download manually
              </a>
            </Button>
          )}
        </div>
        {installLog && (
          <pre className="mt-3 max-h-48 overflow-auto rounded bg-secondary p-2 text-[11px] font-mono text-muted-foreground whitespace-pre-wrap break-all">
            {installLog}
          </pre>
        )}
      </section>
    );
  }

  // Installed: either show Saved/Edit actions, OR show input form.
  const showInput = !status.authtokenSet || editingToken;

  if (showInput) {
    return (
      <section className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-4">
        <div className="flex items-center gap-2 mb-2">
          <Key size={14} className="text-amber-500" />
          <h3 className="text-sm font-semibold">
            {status.authtokenSet ? "Replace ngrok authtoken" : "ngrok authtoken needed"}
          </h3>
        </div>
        <p className="text-[11px] text-muted-foreground mb-3">
          Get your token from{" "}
          <a
            href={NGROK_AUTHTOKEN_DASHBOARD}
            target="_blank"
            rel="noreferrer"
            className="text-primary underline-offset-2 hover:underline inline-flex items-center gap-1"
          >
            dashboard.ngrok.com <ExternalLink size={10} />
          </a>
          {" "}— free signup, takes a minute. Saved to{" "}
          <code className="font-mono">~/.claude/bridge.json</code> with mode 0600.
        </p>
        <div className="flex flex-wrap gap-2 items-end">
          <div className="grid gap-1.5 flex-1 min-w-[260px]">
            <Label htmlFor="ngrok-authtoken">Authtoken</Label>
            <Input
              id="ngrok-authtoken"
              value={authtoken}
              onChange={(e) => setAuthtoken(e.target.value)}
              placeholder="2abcd…XYZ"
              autoComplete="off"
              spellCheck={false}
              type="password"
            />
          </div>
          <Button onClick={saveToken} disabled={savingToken || !authtoken.trim()}>
            {savingToken ? "Saving…" : "Save"}
          </Button>
          {status.authtokenSet && (
            <Button
              variant="ghost"
              onClick={() => {
                setEditingToken(false);
                setAuthtoken("");
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
    <section className="rounded-lg border border-emerald-500/30 bg-emerald-500/5 p-3">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <CheckCircle2 size={14} className="text-emerald-500" />
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
          onClick={() => setEditingToken(true)}
          className="text-fg-dim"
        >
          <Pencil size={11} /> Replace
        </Button>
        <Button
          variant="ghost"
          size="xs"
          onClick={() => void clearToken()}
          className="text-fg-dim hover:text-destructive"
        >
          <Trash2 size={11} /> Clear
        </Button>
      </div>
    </section>
  );
}

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
  const [showLog, setShowLog] = useState(false);
  const [copied, setCopied] = useState(false);
  const toast = useToast();
  const live = t.status === "running" || t.status === "starting";
  const canRestart = t.status === "stopped" || t.status === "error";

  const copy = async () => {
    if (!t.url) return;
    try {
      await navigator.clipboard.writeText(t.url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast("error", "Copy failed");
    }
  };

  return (
    <div
      className={`rounded-lg border bg-card p-3 transition-colors ${
        t.status === "running"
          ? "border-emerald-500/30"
          : t.status === "error"
            ? "border-destructive/30"
            : "border-border"
      }`}
    >
      <div className="flex flex-wrap items-center gap-2">
        <StatusPill status={t.status} />
        <span className="text-[10px] uppercase tracking-wide font-medium px-1.5 py-0.5 rounded bg-secondary text-muted-foreground">
          {t.provider}
        </span>
        <span className="text-sm font-mono">:{t.port}</span>
        {t.subdomain && (
          <span className="text-[11px] text-muted-foreground font-mono">
            ↗ {t.subdomain}
          </span>
        )}
        {t.label && (
          <span className="text-xs text-muted-foreground truncate">— {t.label}</span>
        )}
        <div className="flex-1" />
        {live && (
          <Button variant="ghost" size="xs" onClick={onStop} className="text-fg-dim hover:text-destructive">
            <Square size={12} /> Stop
          </Button>
        )}
        {canRestart && (
          <Button variant="ghost" size="xs" onClick={onRestart} className="text-fg-dim hover:text-foreground">
            <RotateCw size={12} /> Restart
          </Button>
        )}
        <Button variant="ghost" size="xs" onClick={onRemove} className="text-fg-dim hover:text-destructive">
          <Trash2 size={12} /> Remove
        </Button>
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-2">
        {t.url ? (
          <>
            <a
              href={t.url}
              target="_blank"
              rel="noreferrer"
              className="text-sm font-mono text-primary underline-offset-2 hover:underline inline-flex items-center gap-1 break-all"
            >
              {t.url}
              <ExternalLink size={12} />
            </a>
            <Button variant="ghost" size="xs" onClick={() => void copy()}>
              <Copy size={11} /> {copied ? "Copied" : "Copy"}
            </Button>
            {t.provider === "ngrok" && live && (
              <Button asChild variant="ghost" size="xs" className="text-fg-dim">
                <a href={NGROK_INSPECTOR_URL} target="_blank" rel="noreferrer" title="ngrok web inspector">
                  <Eye size={11} /> Inspector
                </a>
              </Button>
            )}
          </>
        ) : t.status === "starting" ? (
          <span className="text-xs text-muted-foreground inline-flex items-center gap-1.5">
            <span className="inline-block h-1.5 w-1.5 rounded-full bg-amber-500 animate-pulse" />
            Waiting for URL…
          </span>
        ) : (
          <span className="text-xs text-muted-foreground">No URL</span>
        )}
      </div>

      {t.error && (
        <p className="mt-2 text-xs text-destructive break-all">{t.error}</p>
      )}

      <div className="mt-2 flex items-center gap-3 text-[11px] text-muted-foreground">
        <span>Started {new Date(t.startedAt).toLocaleTimeString()}</span>
        {t.endedAt && <span>· Ended {new Date(t.endedAt).toLocaleTimeString()}</span>}
        {t.log.length > 0 && (
          <button
            type="button"
            onClick={() => setShowLog((v) => !v)}
            className="underline-offset-2 hover:underline"
          >
            {showLog ? "Hide log" : `Show log (${t.log.length})`}
          </button>
        )}
      </div>

      {showLog && t.log.length > 0 && (
        <pre className="mt-2 max-h-40 overflow-auto rounded bg-secondary p-2 text-[11px] font-mono text-muted-foreground whitespace-pre-wrap break-all">
          {t.log.join("\n")}
        </pre>
      )}
    </div>
  );
}

/**
 * Status pill. The `starting` variant pulses to make the in-flight
 * state visible at a glance — nothing is more confusing than a static
 * yellow badge that's actually idle.
 */
function StatusPill({ status }: { status: TunnelEntry["status"] }) {
  const map: Record<TunnelEntry["status"], { label: string; cls: string }> = {
    starting: {
      label: "starting",
      cls: "bg-amber-500/15 text-amber-600 dark:text-amber-400 animate-pulse",
    },
    running: {
      label: "running",
      cls: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
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
    <span className={`text-[10px] uppercase tracking-wide font-medium px-1.5 py-0.5 rounded ${cls}`}>
      {label}
    </span>
  );
}

export default TunnelsPage;
