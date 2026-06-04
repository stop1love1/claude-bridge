"use client";

import { useEffect, useRef, useState } from "react";
import { Monitor, ExternalLink, RotateCw } from "lucide-react";
import { api } from "@/libs/client/api";

/**
 * Live App Preview (Epic C). Embeds the running app's UI in a sandboxed
 * iframe. The operator can set/update the per-app preview URL inline; a
 * guest sees it read-only (only when the share grants `viewPreview`).
 * Always offers an "open in new tab" fallback for framing-restricted apps.
 */
export function LivePreview({
  taskId,
  mode,
  canView = true,
}: {
  taskId: string;
  mode: "operator" | "guest";
  canView?: boolean;
}) {
  const [url, setUrl] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [port, setPort] = useState("3000");
  const [exposing, setExposing] = useState(false);
  const open = useRef(false);

  useEffect(() => {
    // Guest without the grant: no fetch (the GET would 403 anyway); the
    // read-only "not shared" note renders below without needing `loaded`.
    if (mode === "guest" && !canView) return;
    const ac = new AbortController();
    void (async () => {
      try {
        const r = await api.taskPreview(taskId, { signal: ac.signal });
        if (ac.signal.aborted) return;
        setUrl(r.url);
        setDraft(r.url ?? "");
      } catch {
        /* 403 for guest w/o grant, or no app yet — handled by empty state */
      } finally {
        if (!ac.signal.aborted) setLoaded(true);
      }
    })();
    return () => ac.abort();
  }, [taskId, mode, canView]);

  async function save() {
    setSaving(true);
    setErr(null);
    try {
      const r = await api.updateTaskPreview(taskId, draft.trim());
      setUrl(r.url);
      setDraft(r.url ?? "");
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  /**
   * Expose a local dev port to a public URL via localtunnel (no signup),
   * then set it as this task's preview so guests can reach it. Note: the
   * first hit on a localtunnel URL shows an interstitial that breaks iframe
   * embedding — the "Open in new tab" link still works, and so does sharing
   * the URL with a guest.
   */
  async function expose() {
    const p = Number(port);
    if (!Number.isInteger(p) || p < 1 || p > 65535) { setErr("invalid port"); return; }
    setExposing(true);
    setErr(null);
    try {
      const { tunnel } = await api.startTunnel({ port: p, provider: "localtunnel", label: `preview ${taskId}` });
      // Poll for the public URL (localtunnel emits it on stdout after a beat).
      let found: string | null = null;
      for (let i = 0; i < 16 && !found; i++) {
        await new Promise((r) => setTimeout(r, 1500));
        const { tunnels } = await api.tunnels();
        const t = tunnels.find((x) => x.id === tunnel.id);
        if (t?.url) found = t.url;
        else if (t?.error) throw new Error(t.error);
      }
      if (!found) throw new Error("tunnel did not come up in time — check the Tunnels page");
      const r = await api.updateTaskPreview(taskId, found);
      setUrl(r.url);
      setDraft(r.url ?? "");
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setExposing(false);
    }
  }

  // Guest without the grant: a quiet note, never the URL.
  if (mode === "guest" && !canView) {
    return (
      <div className="rounded-lg border border-border bg-card/50 p-3 text-xs text-muted-foreground">
        <Monitor className="inline h-3.5 w-3.5 mr-1 -mt-0.5" /> Live preview not shared.
      </div>
    );
  }
  if (!loaded) return null;
  // Guest with grant but nothing configured: stay out of the way.
  if (mode === "guest" && !url) return null;

  return (
    <div className="rounded-lg border border-border bg-card overflow-hidden">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-border text-xs">
        <Monitor className="h-3.5 w-3.5 text-primary shrink-0" />
        <span className="font-medium">Live preview</span>
        {mode === "operator" ? (
          <input
            className="flex-1 min-w-0 rounded border border-border bg-background px-2 py-1 text-xs font-mono"
            placeholder="http://localhost:3000  (or a public tunnel URL for guests)"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") void save(); }}
          />
        ) : (
          <span className="flex-1 min-w-0 truncate font-mono text-muted-foreground">{url}</span>
        )}
        {mode === "operator" && (
          <button
            type="button"
            onClick={() => void save()}
            disabled={saving || draft.trim() === (url ?? "")}
            className="rounded bg-primary px-2 py-1 text-[11px] text-primary-foreground disabled:opacity-50"
          >
            {saving ? "…" : "Save"}
          </button>
        )}
        {url && (
          <>
            <button type="button" onClick={() => setReloadKey((k) => k + 1)} title="Reload" className="p-1 rounded hover:bg-accent">
              <RotateCw className="h-3.5 w-3.5" />
            </button>
            <a href={url} target="_blank" rel="noreferrer" title="Open in new tab" className="p-1 rounded hover:bg-accent">
              <ExternalLink className="h-3.5 w-3.5" />
            </a>
          </>
        )}
      </div>
      {mode === "operator" && (
        <div className="flex flex-wrap items-center gap-2 px-3 py-1.5 border-b border-border text-[11px] text-muted-foreground">
          <span>Or expose a local port:</span>
          <input
            type="number"
            min={1}
            max={65535}
            value={port}
            onChange={(e) => setPort(e.target.value)}
            className="w-20 rounded border border-border bg-background px-1.5 py-0.5"
          />
          <button
            type="button"
            onClick={() => void expose()}
            disabled={exposing}
            className="rounded border border-border px-2 py-0.5 disabled:opacity-50 hover:bg-accent"
          >
            {exposing ? "Exposing…" : "Expose via tunnel"}
          </button>
          <span className="text-[10px] opacity-70">localtunnel · public URL · first hit shows an interstitial (use Open-in-tab)</span>
        </div>
      )}
      {err && <div className="px-3 py-1.5 text-[11px] text-red-500">{err}</div>}
      {url ? (
        <iframe
          key={reloadKey}
          src={url}
          title="Live app preview"
          className="w-full h-[360px] sm:h-[480px] bg-white"
          sandbox="allow-scripts allow-forms allow-same-origin allow-popups"
          referrerPolicy="no-referrer"
          onLoad={() => { open.current = true; }}
        />
      ) : (
        <div className="px-3 py-6 text-center text-xs text-muted-foreground">
          {mode === "operator"
            ? "Set a reachable URL above (localhost for you, a public tunnel/staging URL for guests)."
            : "No preview configured yet."}
        </div>
      )}
    </div>
  );
}
