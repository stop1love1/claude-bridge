"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal, type ITheme } from "@xterm/xterm";
import {
  AlertTriangle,
  Copy,
  Focus,
  Loader2,
  RotateCw,
  Terminal as TerminalGlyph,
  Trash2,
} from "lucide-react";
import { cn } from "@/libs/cn";
import { Button } from "./ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "./ui/tooltip";
import "@xterm/xterm/css/xterm.css";

const PTY_PATH = "/api/apps/ws-pty";
const MIN_PTY_PX = 8;

function hostHasLayout(el: HTMLElement): boolean {
  return el.clientWidth >= MIN_PTY_PX && el.clientHeight >= MIN_PTY_PX;
}

function safeFit(host: HTMLElement, fit: FitAddon): boolean {
  if (!hostHasLayout(host)) return false;
  try {
    fit.fit();
    return true;
  } catch {
    return false;
  }
}

/**
 * Colours from the live `:root` palette so toggling light/dark updates xterm
 * (xterm resolves theme strings once; `var(--…)` alone does not follow DOM changes).
 */
function buildXtermThemeResolved(): ITheme {
  if (typeof document === "undefined") {
    return { background: "#0b0d12", foreground: "#e3e6ec" };
  }
  const r = (name: string, fb: string) => {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return v || fb;
  };
  const bg = r("--background", "#0b0d12");
  const fg = r("--foreground", "#e3e6ec");
  const primary = r("--primary", "#6aa8ff");
  const pf = r("--primary-foreground", "#0b0d12");
  const dest = r("--destructive", "#e27070");
  const succ = r("--success", "#65c58c");
  const warn = r("--warning", "#e3b95a");
  const info = r("--info", "#b17ad8");
  const mf = r("--muted-foreground", "#8b92a0");
  const dim = r("--fg-dim", "#636a78");
  return {
    background: bg,
    foreground: fg,
    cursor: primary,
    cursorAccent: pf,
    selectionBackground: `color-mix(in oklab, ${primary} 28%, transparent)`,
    selectionForeground: fg,
    black: fg,
    red: dest,
    green: succ,
    yellow: warn,
    blue: primary,
    magenta: info,
    cyan: `color-mix(in oklab, ${primary} 65%, ${succ})`,
    white: mf,
    brightBlack: dim,
    brightRed: `color-mix(in oklab, ${dest} 88%, white)`,
    brightGreen: `color-mix(in oklab, ${succ} 85%, white)`,
    brightYellow: `color-mix(in oklab, ${warn} 88%, white)`,
    brightBlue: `color-mix(in oklab, ${primary} 88%, white)`,
    brightMagenta: `color-mix(in oklab, ${info} 88%, white)`,
    brightCyan: `color-mix(in oklab, ${primary} 55%, ${succ})`,
    brightWhite: fg,
  };
}

function applyXtermTheme(term: Terminal) {
  term.options.theme = { ...buildXtermThemeResolved() };
  const end = Math.max(0, term.rows - 1);
  term.refresh(0, end);
  try {
    term.clearTextureAtlas();
  } catch {
    /* ignore */
  }
}

type Props = {
  appSegment: string;
  active: boolean;
};

type ConnUi = "checking" | "opening" | "live" | "offline";

type DiagKind =
  | "auth"
  | "wrong-server"
  | "csrf"
  | "demo"
  | "server"
  | "network"
  | "ws-1006"
  | "ws-other";

interface Diag {
  kind: DiagKind;
  title: string;
  hint?: string;
}

type TicketResult =
  | { ok: true; ticket?: string; ptyReady: boolean }
  | { ok: false; diag: Diag };

/**
 * One unified call site for the ticket POST so every non-OK status maps
 * to a clear, actionable diagnostic instead of falling through to a
 * cryptic 1006. The returned Diag is what the toolbar banner renders.
 */
async function fetchTicket(): Promise<TicketResult> {
  let r: Response;
  try {
    r = await fetch("/api/apps/pty-ws-ticket", {
      method: "POST",
      credentials: "include",
    });
  } catch {
    return {
      ok: false,
      diag: {
        kind: "network",
        title: "Bridge unreachable",
        hint: "Dev server stopped or restarting — wait a moment and reconnect.",
      },
    };
  }
  if (r.status === 401) {
    return {
      ok: false,
      diag: {
        kind: "auth",
        title: "Sign-in required",
        hint: "Session expired. Re-login using the same URL host (localhost vs 127.0.0.1).",
      },
    };
  }
  if (r.status === 403) {
    return {
      ok: false,
      diag: {
        kind: "csrf",
        title: "Cross-origin blocked",
        hint: "Page origin doesn't match the bridge host. Open via the same URL you logged in with.",
      },
    };
  }
  if (r.status === 503) {
    return {
      ok: false,
      diag: {
        kind: "demo",
        title: "Demo mode",
        hint: "BRIDGE_DEMO_MODE is set — interactive shell is disabled.",
      },
    };
  }
  if (!r.ok) {
    return {
      ok: false,
      diag: {
        kind: "server",
        title: `Bridge returned ${r.status}`,
        hint: "Check the dev server log for details.",
      },
    };
  }
  const j = (await r.json().catch(() => null)) as
    | { ticket?: string; ptyReady?: boolean }
    | null;
  return {
    ok: true,
    ticket: typeof j?.ticket === "string" ? j.ticket : undefined,
    ptyReady: j?.ptyReady === true,
  };
}

/**
 * xterm + PTY WebSocket — toolbar, connection status, copy/clear/focus.
 */
export function AppInteractiveTerminal({ appSegment, active }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  /**
   * One-shot retry guard: 1006 closes that never even opened are usually
   * transient (ticket consumed by a stale tab, double-mount in dev). We
   * silently retry once before raising a banner. Reset on successful
   * open and on manual Reconnect.
   */
  const retriedRef = useRef(false);
  const [diag, setDiag] = useState<Diag | null>(null);
  const [connUi, setConnUi] = useState<ConnUi>("checking");
  const [reconnectKey, setReconnectKey] = useState(0);
  const [copyFlash, setCopyFlash] = useState(false);
  const [clipboardNote, setClipboardNote] = useState<string | null>(null);

  const reconnect = useCallback(() => {
    retriedRef.current = false;
    setReconnectKey((k) => k + 1);
  }, []);

  const focusTerminal = useCallback(() => {
    termRef.current?.focus();
  }, []);

  const clearTerminal = useCallback(() => {
    termRef.current?.clear();
    focusTerminal();
  }, [focusTerminal]);

  const copySelection = useCallback(async () => {
    const t = termRef.current;
    if (!t) return;
    const text = t.getSelection();
    if (!text?.trim()) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopyFlash(true);
      window.setTimeout(() => setCopyFlash(false), 1200);
    } catch {
      setClipboardNote("Clipboard blocked — allow clipboard for this site.");
      window.setTimeout(() => setClipboardNote(null), 4000);
    }
  }, []);

  useEffect(() => {
    const host = hostRef.current;
    if (!host || !active) {
      wsRef.current?.close();
      wsRef.current = null;
      termRef.current?.dispose();
      termRef.current = null;
      fitRef.current = null;
      return;
    }

    setDiag(null);
    setConnUi("checking");
    let released = false;
    const term = new Terminal({
      cursorBlink: true,
      fontSize: 13,
      lineHeight: 1.25,
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
      cols: 80,
      rows: 24,
      scrollback: 5000,
      theme: { ...buildXtermThemeResolved() },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    termRef.current = term;
    fitRef.current = fit;

    const sendResizeToWs = (ws: WebSocket | null) => {
      if (ws?.readyState !== WebSocket.OPEN) return;
      ws.send(JSON.stringify({ t: "resize", c: term.cols, r: term.rows }));
    };

    let disposeWs: (() => void) | null = null;

    const wireWebSocket = async () => {
      setConnUi("opening");
      const t = await fetchTicket();
      if (released) return;
      if (!t.ok) {
        setDiag(t.diag);
        setConnUi("offline");
        return;
      }
      if (!t.ptyReady) {
        setDiag({
          kind: "wrong-server",
          title: "Shell server not loaded",
          hint: "Stop the dev server (Ctrl+C) and run `bun dev`. Plain `next dev` lacks the PTY upgrade handler — that's why the WebSocket hangs.",
        });
        setConnUi("offline");
        return;
      }

      const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
      const qs = new URLSearchParams({ app: appSegment });
      if (t.ticket) qs.set("ticket", t.ticket);
      const ws = new WebSocket(`${proto}//${window.location.host}${PTY_PATH}?${qs.toString()}`);
      wsRef.current = ws;
      ws.binaryType = "arraybuffer";

      let opened = false;
      ws.onopen = () => {
        opened = true;
        retriedRef.current = false;
        setDiag(null);
        setConnUi("live");
        safeFit(host, fit);
        sendResizeToWs(ws);
        term.focus();
      };
      ws.onmessage = (ev) => {
        const data =
          typeof ev.data === "string" ? ev.data : new TextDecoder().decode(ev.data as ArrayBuffer);
        term.write(data);
      };
      ws.onerror = () => {
        if (released) return;
        // Don't surface a banner here — the close handler runs next and
        // has the actual close code (1006 vs 1011 vs …) we want to
        // explain. Setting status alone keeps the pill in sync.
        setConnUi("offline");
      };
      ws.onclose = (ev) => {
        wsRef.current = null;
        if (released) return;
        setConnUi("offline");
        // Silent one-shot retry on transient 1006 (handshake never
        // opened). Covers StrictMode double-mount + stale-ticket races.
        if (ev.code === 1006 && !opened && !retriedRef.current) {
          retriedRef.current = true;
          window.setTimeout(() => {
            if (!released) void wireWebSocket();
          }, 350);
          return;
        }
        if (ev.wasClean) return;
        if (ev.code === 1006) {
          setDiag({
            kind: "ws-1006",
            title: "Shell handshake rejected",
            hint: "Likely the bridge server isn't running with PTY support, or the session cookie isn't valid for this host. Restart with `bun dev` and re-login on the same URL.",
          });
        } else {
          setDiag({
            kind: "ws-other",
            title: `Shell disconnected · code ${ev.code}`,
            hint: ev.reason?.trim() || "Reconnect to start a fresh shell.",
          });
        }
      };

      const d = term.onData((data) => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ t: "in", d: data }));
        }
      });

      disposeWs = () => {
        d.dispose();
        try {
          ws.close();
        } catch {
          /* ignore */
        }
        wsRef.current = null;
      };
    };

    let bootstrapped = false;
    let bootPending = false;
    const layoutRo = new ResizeObserver(() => {
      if (released) return;
      if (!hostHasLayout(host)) return;

      if (!bootstrapped && !bootPending) {
        bootPending = true;
        bootstrapped = true;
        bootPending = false;
        term.open(host);
        applyXtermTheme(term);
        safeFit(host, fit);
        void wireWebSocket();
      } else if (bootstrapped && safeFit(host, fit)) {
        sendResizeToWs(wsRef.current);
      }
    });
    layoutRo.observe(host);

    return () => {
      released = true;
      layoutRo.disconnect();
      disposeWs?.();
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
      setConnUi("offline");
    };
  }, [appSegment, active, reconnectKey]);

  /** ThemeProvider updates `data-theme` in an effect — observe the DOM so we always repaint after it. */
  useEffect(() => {
    if (!active) return;
    const sync = () => {
      const t = termRef.current;
      if (t) applyXtermTheme(t);
    };
    const mo = new MutationObserver(sync);
    mo.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });
    sync();
    return () => mo.disconnect();
  }, [active]);

  if (!active) return null;

  const canUseShell = connUi === "live";
  const isBusy = connUi === "checking" || connUi === "opening";

  return (
    <div className="flex flex-1 min-h-0 flex-col gap-1.5">
      <Toolbar
        connUi={connUi}
        diag={diag}
        canUseShell={canUseShell}
        isBusy={isBusy}
        copyFlash={copyFlash}
        onClear={clearTerminal}
        onCopy={() => void copySelection()}
        onFocus={focusTerminal}
        onReconnect={reconnect}
      />

      {diag && <DiagBanner diag={diag} onRetry={reconnect} busy={isBusy} />}

      {clipboardNote && (
        <p
          className="shrink-0 truncate rounded-md border border-warning/35 bg-warning/10 px-2 py-1 text-2xs text-warning"
          title={clipboardNote}
        >
          {clipboardNote}
        </p>
      )}

      <div
        ref={hostRef}
        role="presentation"
        onClick={focusTerminal}
        title={statusTitleFor(connUi)}
        className={cn(
          "bridge-xterm-host relative flex-1 min-h-[88px] min-w-0 w-full cursor-text overflow-hidden rounded-lg border border-border/70 bg-card/40 shadow-inner transition-shadow",
          "outline-none focus-within:border-primary/50 focus-within:ring-2 focus-within:ring-ring/30",
          connUi === "offline" && "border-border/50",
        )}
      >
        {isBusy && (
          <div
            className="pointer-events-none absolute inset-0 flex items-center justify-center"
            aria-hidden
          >
            <div className="flex items-center gap-2 rounded-full border border-border/60 bg-background/85 px-3 py-1.5 text-xs text-fg-dim shadow-sm backdrop-blur">
              <Loader2 size={12} className="animate-spin text-primary" />
              <span>{connUi === "checking" ? "Authorising…" : "Establishing shell…"}</span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/* ─────────────────────────── Toolbar ─────────────────────────── */

function Toolbar({
  connUi,
  diag,
  canUseShell,
  isBusy,
  copyFlash,
  onClear,
  onCopy,
  onFocus,
  onReconnect,
}: {
  connUi: ConnUi;
  diag: Diag | null;
  canUseShell: boolean;
  isBusy: boolean;
  copyFlash: boolean;
  onClear: () => void;
  onCopy: () => void;
  onFocus: () => void;
  onReconnect: () => void;
}) {
  return (
    <div className="flex shrink-0 items-center gap-2 px-1.5 py-1">
      <StatusPill connUi={connUi} hasError={!!diag} />
      <div className="ml-auto flex items-center gap-0.5">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="iconSm"
              className="text-fg-dim hover:text-foreground"
              disabled={!canUseShell}
              onClick={onClear}
              aria-label="Clear terminal"
            >
              <Trash2 size={12} />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="top">Clear screen</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="iconSm"
              className={cn(
                "text-fg-dim hover:text-foreground",
                copyFlash && "text-success hover:text-success",
              )}
              disabled={!canUseShell}
              onClick={onCopy}
              aria-label={copyFlash ? "Copied" : "Copy selection"}
            >
              <Copy size={12} />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="top">{copyFlash ? "Copied" : "Copy selection"}</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="iconSm"
              className="text-fg-dim hover:text-foreground"
              disabled={!canUseShell}
              onClick={onFocus}
              aria-label="Focus terminal"
            >
              <Focus size={12} />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="top">Focus for typing</TooltipContent>
        </Tooltip>
        <span className="mx-0.5 h-4 w-px bg-border/60" aria-hidden />
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="outline"
              size="iconSm"
              className="border-border/80"
              onClick={onReconnect}
              disabled={isBusy}
              aria-label="Reconnect shell"
            >
              {isBusy ? (
                <Loader2 size={12} className="animate-spin" />
              ) : (
                <RotateCw size={12} />
              )}
            </Button>
          </TooltipTrigger>
          <TooltipContent side="top">Reconnect</TooltipContent>
        </Tooltip>
      </div>
    </div>
  );
}

/* ─────────────────────────── Status pill ─────────────────────────── */

function StatusPill({ connUi, hasError }: { connUi: ConnUi; hasError: boolean }) {
  const cfg =
    connUi === "live"
      ? {
          dot: "bg-success shadow-[0_0_0_3px] shadow-success/20",
          text: "text-success",
          ring: "border-success/25 bg-success/10",
          label: "Live",
        }
      : connUi === "checking"
        ? {
            dot: "bg-primary/70 animate-pulse",
            text: "text-primary",
            ring: "border-primary/25 bg-primary/10",
            label: "Authorising",
          }
        : connUi === "opening"
          ? {
              dot: "bg-warning animate-pulse",
              text: "text-warning",
              ring: "border-warning/25 bg-warning/10",
              label: "Connecting",
            }
          : {
              dot: hasError ? "bg-destructive" : "bg-muted-foreground/55",
              text: hasError ? "text-destructive" : "text-fg-dim",
              ring: hasError ? "border-destructive/25 bg-destructive/10" : "border-border/60 bg-muted/40",
              label: hasError ? "Error" : "Idle",
            };
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-2xs font-medium tabular-nums",
        cfg.ring,
        cfg.text,
      )}
      title={statusTitleFor(connUi)}
    >
      <TerminalGlyph size={10} className="opacity-70" aria-hidden />
      <span className={cn("h-1.5 w-1.5 rounded-full", cfg.dot)} aria-hidden />
      <span>{cfg.label}</span>
    </span>
  );
}

function statusTitleFor(c: ConnUi): string {
  return c === "checking"
    ? "Checking session"
    : c === "opening"
      ? "Connecting shell"
      : c === "live"
        ? "Connected — click terminal to type; paste with Ctrl+V / Cmd+V"
        : "Disconnected";
}

/* ─────────────────────────── Diagnostic banner ─────────────────────────── */

function DiagBanner({
  diag,
  onRetry,
  busy,
}: {
  diag: Diag;
  onRetry: () => void;
  busy: boolean;
}) {
  return (
    <div
      role="alert"
      className="shrink-0 flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 px-2.5 py-1.5"
    >
      <AlertTriangle size={13} className="shrink-0 mt-0.5 text-destructive" aria-hidden />
      <div className="min-w-0 flex-1 space-y-0.5">
        <p className="text-2xs font-semibold text-destructive truncate" title={diag.title}>
          {diag.title}
        </p>
        {diag.hint && (
          <p className="text-2xs text-foreground/85 leading-snug" title={diag.hint}>
            {diag.hint}
          </p>
        )}
      </div>
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="shrink-0 h-6 px-2 text-2xs border-destructive/30 text-destructive hover:bg-destructive/15 hover:text-destructive"
        onClick={onRetry}
        disabled={busy}
      >
        {busy ? <Loader2 size={11} className="animate-spin" /> : <RotateCw size={11} />}
        <span>Retry</span>
      </Button>
    </div>
  );
}
