"use client";

import { useEffect, useMemo, useState } from "react";
import {
  Activity,
  AlertTriangle,
  ArrowDownToLine,
  ArrowUpFromLine,
  Database,
  Gauge,
  RefreshCw,
  Trophy,
  Sparkles,
} from "lucide-react";
import { api } from "@/libs/client/api";
import type {
  UsageSnapshot,
  UsageModel,
  QuotaWindow,
  ExtraUsage,
} from "@/libs/client/types";
import { HeaderShell } from "../_components/HeaderShell";
import { useToast } from "../_components/Toasts";
import { EmptyState } from "../_components/ui/empty-state";

/**
 * Pretty-print large integers with thousand separators. Uses the user's
 * locale via `toLocaleString` so European number formats just work.
 */
function fmt(n: number): string {
  return n.toLocaleString();
}

/**
 * Compact byte-style integer: 1_234_567 → "1.23M", 4321 → "4.32K".
 * Used in the dense per-model table where the full number wouldn't fit.
 */
function compact(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return (n / 1000).toFixed(n < 10_000 ? 2 : 1) + "K";
  if (n < 1_000_000_000) return (n / 1_000_000).toFixed(n < 10_000_000 ? 2 : 1) + "M";
  return (n / 1_000_000_000).toFixed(2) + "B";
}

/**
 * "1h 10m", "45s", "3d 2h" — the longest-session card needs a quick
 * read on duration without dragging in a date library.
 */
function formatDuration(ms: number): string {
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ${sec - min * 60}s`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ${min - hr * 60}m`;
  const day = Math.floor(hr / 24);
  return `${day}d ${hr - day * 24}h`;
}

/**
 * "Resets Sat 9:00 PM" / "Resets in 55 min" shape — matches claude.ai's
 * settings page. Local timezone, since the operator is reading it.
 */
function formatResetsAt(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return iso;
  const diffMs = d.getTime() - Date.now();
  // Within 24h → "in 55 min" / "in 3h" so the eye latches on the
  // urgency. Beyond → calendar shape.
  if (diffMs < 24 * 60 * 60 * 1000 && diffMs > 0) {
    const min = Math.round(diffMs / 60_000);
    if (min < 60) return `in ${min} min`;
    const h = Math.floor(min / 60);
    const m = min - h * 60;
    return m ? `in ${h}h ${m}m` : `in ${h}h`;
  }
  const wd = d.toLocaleDateString(undefined, { weekday: "short" });
  const t = d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  return `${wd} ${t}`;
}

function timeAgo(iso: string | null): string {
  if (!iso) return "never";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return iso;
  const sec = Math.max(1, Math.floor((Date.now() - t) / 1000));
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `${day}d ago`;
  const mo = Math.floor(day / 30);
  return `${mo}mo ago`;
}

/**
 * Strip the `claude-` prefix and any trailing date suffix so the table
 * shows `opus-4-7` instead of `claude-opus-4-7-20251015`.
 */
function shortModel(id: string): string {
  return id.replace(/^claude-/, "").replace(/-\d{8}$/, "");
}

/**
 * Sum every token bucket on a model row — used to compute the share %
 * that drives the bar widths in the model table.
 */
function modelTotal(m: UsageModel): number {
  return (
    m.inputTokens +
    m.outputTokens +
    m.cacheReadInputTokens +
    m.cacheCreationInputTokens
  );
}

export default function UsagePage() {
  const toast = useToast();
  const [snap, setSnap] = useState<UsageSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  // `force` bypasses the server-side cache for the manual refresh button.
  // Background polls always reuse cache so we stay well under Anthropic's
  // per-minute rate limit on `/api/oauth/usage`.
  const refresh = async (force = false) => {
    setRefreshing(true);
    try {
      setSnap(await api.usage(force));
    } catch (e) {
      toast("error", (e as Error).message);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  useEffect(() => {
    void refresh();
    // Server-side cache for the snapshot is 60 s on success / 8 s on
    // error, so polling more aggressively wastes round-trips. 60 s is
    // the natural cadence — quota %s don't move faster than that.
    const t = setInterval(() => { void refresh(); }, 60_000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const lifetimeTokens = useMemo(() => {
    if (!snap) return { input: 0, output: 0, cacheRead: 0, cacheCreate: 0, web: 0 };
    let input = 0, output = 0, cacheRead = 0, cacheCreate = 0, web = 0;
    for (const m of Object.values(snap.modelUsage)) {
      input += m.inputTokens;
      output += m.outputTokens;
      cacheRead += m.cacheReadInputTokens;
      cacheCreate += m.cacheCreationInputTokens;
      web += m.webSearchRequests;
    }
    return { input, output, cacheRead, cacheCreate, web };
  }, [snap]);

  const grandTotal =
    lifetimeTokens.input +
    lifetimeTokens.output +
    lifetimeTokens.cacheRead +
    lifetimeTokens.cacheCreate;

  // Last 30 days of activity, oldest → newest, padding missing days with 0
  // so the bars line up on the time axis instead of clumping on whichever
  // days the CLI happened to record.
  const dailyBars = useMemo(() => {
    if (!snap || snap.dailyActivity.length === 0) return [];
    const byDate = new Map(snap.dailyActivity.map((d) => [d.date, d.messageCount]));
    const out: Array<{ date: string; messages: number }> = [];
    const today = new Date();
    for (let i = 29; i >= 0; i--) {
      const d = new Date(today);
      d.setDate(today.getDate() - i);
      const key = d.toISOString().slice(0, 10);
      out.push({ date: key, messages: byDate.get(key) ?? 0 });
    }
    return out;
  }, [snap]);
  const dailyMax = Math.max(1, ...dailyBars.map((b) => b.messages));

  return (
    <div className="flex flex-col h-screen">
      <HeaderShell />

      <main className="flex-1 overflow-y-auto">
        <div className="max-w-5xl mx-auto p-3 md:p-5 space-y-4">
          <header className="flex items-center gap-2 flex-wrap">
            <Gauge size={16} className="text-primary" />
            <h2 className="text-base font-semibold">Usage</h2>
            {snap?.plan && (
              <span
                className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded border border-success/40 bg-success/10 text-success text-[10.5px] font-mono"
                title={`Plan tier from ~/.claude/.credentials.json`}
              >
                <Sparkles size={10} />
                {snap.plan.subscriptionType}
                {snap.plan.rateLimitTier && (
                  <span className="opacity-70">· {snap.plan.rateLimitTier}</span>
                )}
              </span>
            )}
            <span className="ml-auto inline-flex items-center gap-2 text-[10.5px] text-muted-foreground">
              <span title={snap?.cacheUpdatedAt ?? "no cache file"}>
                cache: {timeAgo(snap?.cacheUpdatedAt ?? null)}
              </span>
              <button
                type="button"
                onClick={() => void refresh(true)}
                disabled={refreshing}
                className="inline-flex items-center justify-center h-6 w-6 rounded-md border border-border text-muted-foreground hover:text-foreground hover:bg-accent disabled:opacity-40"
                title="Refresh"
                aria-label="Refresh usage"
              >
                <RefreshCw size={11} className={refreshing ? "animate-spin" : ""} />
              </button>
            </span>
          </header>

          {/* ─── Live quota panels ─── Same data claude.ai/settings/usage
              and the CLI's `/usage › Usage` tab show. Pulled from
              `/api/oauth/usage` server-side; OAuth token never leaves the
              bridge process. */}
          {snap?.quota && <QuotaSections quota={snap.quota} onRefresh={() => void refresh(true)} />}

          {loading && !snap ? (
            <div className="space-y-2">
              <div className="h-20 rounded-md bg-muted/40 animate-pulse" />
              <div className="h-40 rounded-md bg-muted/40 animate-pulse" />
            </div>
          ) : !snap || snap.source === "missing" ? (
            <EmptyState
              icon={Gauge}
              title="No stats yet"
              hint="Run `claude` and let it work for a bit — Claude Code writes ~/.claude/stats-cache.json once it has activity to report."
            />
          ) : (
            <>
              {/* ─── Lifetime summary tiles ─── */}
              <section className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                <Tile
                  icon={Activity}
                  label="Total messages"
                  value={fmt(snap.totalMessages)}
                  hint={`${snap.totalSessions} session${snap.totalSessions === 1 ? "" : "s"}`}
                />
                <Tile
                  icon={ArrowUpFromLine}
                  label="Input tokens"
                  value={compact(lifetimeTokens.input)}
                  hint={fmt(lifetimeTokens.input)}
                />
                <Tile
                  icon={ArrowDownToLine}
                  label="Output tokens"
                  value={compact(lifetimeTokens.output)}
                  hint={fmt(lifetimeTokens.output)}
                />
                <Tile
                  icon={Database}
                  label="Cache read"
                  value={compact(lifetimeTokens.cacheRead)}
                  hint={`${compact(lifetimeTokens.cacheCreate)} created`}
                />
              </section>

              {/* ─── Daily activity bars (last 30 days) ─── */}
              <section className="rounded-md border border-border bg-card p-3">
                <div className="flex items-center justify-between mb-2">
                  <h3 className="text-[12.5px] font-semibold">Daily activity</h3>
                  <span className="text-[10.5px] text-muted-foreground">
                    last 30 days · max {fmt(dailyMax)} msg/day
                  </span>
                </div>
                <div className="flex items-end gap-[2px] h-20">
                  {dailyBars.map((b) => {
                    const ratio = b.messages / dailyMax;
                    const cls = b.messages === 0
                      ? "bg-muted/40"
                      : ratio > 0.66
                        ? "bg-primary"
                        : ratio > 0.33
                          ? "bg-primary/70"
                          : "bg-primary/40";
                    return (
                      <div
                        key={b.date}
                        className={`flex-1 rounded-sm ${cls}`}
                        style={{ height: `${Math.max(2, ratio * 100)}%` }}
                        title={`${b.date}: ${fmt(b.messages)} message${b.messages === 1 ? "" : "s"}`}
                      />
                    );
                  })}
                </div>
                <div className="flex justify-between mt-1 text-[9.5px] font-mono text-fg-dim">
                  <span>{dailyBars[0]?.date}</span>
                  <span>{dailyBars[dailyBars.length - 1]?.date}</span>
                </div>
              </section>

              {/* ─── Per-model breakdown ─── */}
              <section className="rounded-md border border-border bg-card p-3">
                <h3 className="text-[12.5px] font-semibold mb-2">By model</h3>
                <div className="space-y-2">
                  {Object.entries(snap.modelUsage)
                    .sort((a, b) => modelTotal(b[1]) - modelTotal(a[1]))
                    .map(([modelId, m]) => {
                      const total = modelTotal(m);
                      const sharePct = grandTotal > 0 ? (total / grandTotal) * 100 : 0;
                      return (
                        <div key={modelId} className="rounded-md border border-border/60 bg-background/40 p-2">
                          <div className="flex items-baseline gap-2 mb-1.5">
                            <code className="font-mono text-[12px] font-medium text-foreground">
                              {shortModel(modelId)}
                            </code>
                            <span className="text-[10.5px] text-muted-foreground tabular-nums">
                              {sharePct.toFixed(1)}% of all-model tokens
                            </span>
                            <span className="ml-auto font-mono text-[11px] text-foreground tabular-nums">
                              {compact(total)}
                            </span>
                          </div>
                          <div className="h-1.5 w-full rounded-full bg-muted/40 overflow-hidden">
                            <div
                              className="h-full bg-primary"
                              style={{ width: `${Math.max(1, sharePct)}%` }}
                            />
                          </div>
                          <dl className="mt-2 grid grid-cols-2 sm:grid-cols-4 gap-x-3 gap-y-1 text-[10.5px]">
                            <Stat label="input" value={compact(m.inputTokens)} fullValue={fmt(m.inputTokens)} />
                            <Stat label="output" value={compact(m.outputTokens)} fullValue={fmt(m.outputTokens)} />
                            <Stat label="cache read" value={compact(m.cacheReadInputTokens)} fullValue={fmt(m.cacheReadInputTokens)} />
                            <Stat label="cache create" value={compact(m.cacheCreationInputTokens)} fullValue={fmt(m.cacheCreationInputTokens)} />
                          </dl>
                        </div>
                      );
                    })}
                  {Object.keys(snap.modelUsage).length === 0 && (
                    <p className="text-[11px] text-muted-foreground italic">
                      No per-model data yet.
                    </p>
                  )}
                </div>
              </section>

              {/* ─── Longest session ─── */}
              {snap.longestSession && (
                <section className="rounded-md border border-border bg-card p-3 flex items-start gap-3">
                  <Trophy size={14} className="text-warning shrink-0 mt-0.5" />
                  <div className="min-w-0 flex-1">
                    <h3 className="text-[12.5px] font-semibold">Longest session</h3>
                    <p className="text-[11.5px] text-muted-foreground mt-0.5">
                      <span className="font-mono text-foreground">
                        {formatDuration(snap.longestSession.duration)}
                      </span>
                      {" · "}
                      {fmt(snap.longestSession.messageCount)} messages
                      {" · "}
                      <span title={snap.longestSession.timestamp}>
                        {timeAgo(snap.longestSession.timestamp)}
                      </span>
                    </p>
                    <code className="block mt-1 text-[10.5px] font-mono text-fg-dim truncate">
                      {snap.longestSession.sessionId}
                    </code>
                  </div>
                </section>
              )}

              {/* Footer line — first session + cache recompute date so
                  the user can tell if they're looking at fresh stats or
                  a snapshot the CLI hasn't updated in a few days. */}
              <p className="text-[10.5px] text-muted-foreground text-center pt-1">
                First session{" "}
                {snap.firstSessionDate ? timeAgo(snap.firstSessionDate) : "—"}
                {snap.lastComputedDate && (
                  <> · stats recomputed {snap.lastComputedDate}</>
                )}
              </p>
            </>
          )}
        </div>
      </main>
    </div>
  );
}

function Tile({
  icon: Icon,
  label,
  value,
  hint,
}: {
  icon: React.ComponentType<{ size?: number; className?: string }>;
  label: string;
  value: string;
  hint?: string;
}) {
  return (
    <div className="rounded-md border border-border bg-card p-2.5">
      <div className="flex items-center gap-1.5 text-[10.5px] text-muted-foreground">
        <Icon size={11} className="text-primary" />
        {label}
      </div>
      <div className="mt-1 text-base font-semibold tabular-nums">{value}</div>
      {hint && (
        <div className="text-[10px] text-muted-foreground tabular-nums">{hint}</div>
      )}
    </div>
  );
}

function Stat({ label, value, fullValue }: { label: string; value: string; fullValue: string }) {
  return (
    <div className="flex items-baseline gap-1 min-w-0" title={fullValue}>
      <dt className="text-fg-dim shrink-0">{label}</dt>
      <dd className="font-mono text-foreground tabular-nums truncate">{value}</dd>
    </div>
  );
}

/**
 * Color the bar by utilization band — green/amber/red mirrors how
 * claude.ai's UI nudges attention as you approach the cap.
 */
function utilizationColor(pct: number): string {
  if (pct >= 85) return "bg-destructive";
  if (pct >= 60) return "bg-warning";
  return "bg-primary";
}

interface QuotaRow {
  title: string;
  sub?: string;
  window: QuotaWindow | null;
  /** Hide the row entirely when the window is null (server-side default). */
  hideWhenNull?: boolean;
}

function QuotaBar({ row }: { row: QuotaRow }) {
  if (!row.window && row.hideWhenNull) return null;
  const w = row.window;
  const pct = w ? Math.min(100, Math.max(0, w.utilization)) : 0;
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,2fr)_auto] items-center gap-3 py-2">
      <div className="min-w-0">
        <div className="text-[12.5px] font-medium text-foreground truncate">
          {row.title}
        </div>
        <div className="text-[10.5px] text-muted-foreground truncate">
          {w?.resetsAt
            ? `Resets ${formatResetsAt(w.resetsAt)}`
            : row.sub ?? (w ? "" : "not available on this plan")}
        </div>
      </div>
      <div className="h-2 rounded-full bg-muted/40 overflow-hidden">
        {w && (
          <div
            className={`h-full ${utilizationColor(pct)} transition-all`}
            style={{ width: `${Math.max(1, pct)}%` }}
          />
        )}
      </div>
      <div className="text-[12px] text-muted-foreground tabular-nums whitespace-nowrap min-w-[64px] text-right">
        {w ? `${pct.toFixed(0)}% used` : "—"}
      </div>
    </div>
  );
}

function ExtraUsageBar({ extra }: { extra: ExtraUsage }) {
  if (!extra.isEnabled) {
    return (
      <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,2fr)_auto] items-center gap-3 py-2">
        <div className="min-w-0">
          <div className="text-[12.5px] font-medium text-foreground">Extra usage</div>
          <div className="text-[10.5px] text-muted-foreground">
            Not enabled · run <code className="font-mono text-[11px]">/extra-usage</code> in claude
          </div>
        </div>
        <div className="h-2 rounded-full bg-muted/40" />
        <div className="text-[12px] text-muted-foreground tabular-nums whitespace-nowrap min-w-[64px] text-right">
          off
        </div>
      </div>
    );
  }
  const pct = Math.min(100, Math.max(0, extra.utilization ?? 0));
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,2fr)_auto] items-center gap-3 py-2">
      <div className="min-w-0">
        <div className="text-[12.5px] font-medium text-foreground">Extra usage</div>
        <div className="text-[10.5px] text-muted-foreground tabular-nums">
          {extra.usedCredits != null && extra.monthlyLimit != null
            ? `${extra.usedCredits.toLocaleString()} / ${extra.monthlyLimit.toLocaleString()}${extra.currency ? ` ${extra.currency}` : ""}`
            : "overage credits"}
        </div>
      </div>
      <div className="h-2 rounded-full bg-muted/40 overflow-hidden">
        <div
          className={`h-full ${utilizationColor(pct)} transition-all`}
          style={{ width: `${Math.max(1, pct)}%` }}
        />
      </div>
      <div className="text-[12px] text-muted-foreground tabular-nums whitespace-nowrap min-w-[64px] text-right">
        {pct.toFixed(0)}% used
      </div>
    </div>
  );
}

/**
 * The three-section panel that mirrors claude.ai/settings/usage:
 * "Plan usage limits" (5h session) → "Weekly limits" (per-model bands) →
 * "Additional features" (extra usage + future routine credits when an
 * endpoint exists for those).
 */
function QuotaSections({
  quota,
  onRefresh,
}: {
  quota: NonNullable<UsageSnapshot["quota"]>;
  onRefresh: () => void;
}) {
  if (quota.error) {
    return (
      <div className="flex items-start gap-2 px-3 py-2 rounded-md border border-destructive/40 bg-destructive/5 text-[11.5px]">
        <AlertTriangle size={13} className="text-destructive shrink-0 mt-0.5" />
        <p className="leading-snug text-foreground">
          Live quota unavailable: <code className="font-mono text-[11px]">{quota.error}</code>
        </p>
      </div>
    );
  }
  const weeklyRows: QuotaRow[] = [
    { title: "All models", window: quota.weeklyAllModels },
    { title: "Sonnet only", window: quota.weeklySonnet, hideWhenNull: true },
    { title: "Opus only", window: quota.weeklyOpus, hideWhenNull: true },
    { title: "Claude Design", window: quota.weeklyClaudeDesign, hideWhenNull: true },
    { title: "OAuth apps", window: quota.weeklyOauthApps, hideWhenNull: true },
    { title: "Cowork", window: quota.weeklyCowork, hideWhenNull: true },
  ];
  return (
    <div className="rounded-md border border-border bg-card p-4 space-y-5">
      <section>
        <h3 className="text-[12.5px] font-semibold mb-1">Plan usage limits</h3>
        <QuotaBar row={{ title: "Current session", window: quota.fiveHour }} />
      </section>

      <section>
        <h3 className="text-[12.5px] font-semibold mb-1">Weekly limits</h3>
        <div className="divide-y divide-border/40">
          {weeklyRows.map((r) => <QuotaBar key={r.title} row={r} />)}
        </div>
        <div className="flex items-center gap-1 pt-2 text-[10.5px] text-muted-foreground">
          <span>Last updated {timeAgo(quota.fetchedAt)}</span>
          <button
            type="button"
            onClick={onRefresh}
            className="inline-flex items-center justify-center h-5 w-5 rounded text-muted-foreground hover:text-foreground hover:bg-accent"
            title="Refresh"
            aria-label="Refresh quota"
          >
            <RefreshCw size={10} />
          </button>
        </div>
      </section>

      {quota.extraUsage && (
        <section>
          <h3 className="text-[12.5px] font-semibold mb-1">Additional features</h3>
          <ExtraUsageBar extra={quota.extraUsage} />
        </section>
      )}
    </div>
  );
}
