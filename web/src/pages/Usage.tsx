import { useEffect, useMemo, useState } from "react";
import {
  Activity,
  AlertTriangle,
  ArrowDownToLine,
  ArrowUpFromLine,
  Database,
  Gauge,
  RefreshCw,
  Sparkles,
  Trophy,
  type LucideIcon,
} from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "@/api/client";
import { qk } from "@/api/queries";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import type {
  ExtraUsage,
  QuotaPanel,
  QuotaWindow,
  UsageModel,
  UsageSnapshot,
} from "@/api/types";
import { formatDuration, formatResetsAt, formatTimeAgo } from "@/lib/time";

function isSnapshot(v: unknown): v is UsageSnapshot {
  if (!v || typeof v !== "object") return false;
  return "modelUsage" in v && "totalSessions" in v;
}

function fmt(n: number): string {
  return n.toLocaleString();
}

function compact(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return (n / 1000).toFixed(n < 10_000 ? 2 : 1) + "K";
  if (n < 1_000_000_000)
    return (n / 1_000_000).toFixed(n < 10_000_000 ? 2 : 1) + "M";
  return (n / 1_000_000_000).toFixed(2) + "B";
}

function shortModel(id: string): string {
  return id.replace(/^claude-/, "").replace(/-\d{8}$/, "");
}

function modelTotal(m: UsageModel): number {
  return (
    m.inputTokens +
    m.outputTokens +
    m.cacheReadInputTokens +
    m.cacheCreationInputTokens
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

export default function UsagePage() {
  const qc = useQueryClient();
  // We pull the snapshot via an imperative `useEffect` + `setSnap` instead
  // of useUsage(), so the manual-refresh button can always issue `?force=1`
  // (the cached `useUsage(false)` snapshot wouldn't get bypassed otherwise).
  const [snap, setSnap] = useState<UsageSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = async (force = false) => {
    setRefreshing(true);
    try {
      const r = await api.usage(force);
      setSnap(isSnapshot(r) ? r : null);
      setError(null);
      // Keep the react-query cache in sync so other consumers see fresh data.
      qc.setQueryData(qk.usage, r);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  useEffect(() => {
    void refresh(false);
    // Server-side cache for the snapshot is 60s on success, so polling more
    // aggressively just wastes round-trips.
    const t = setInterval(() => {
      void refresh(false);
    }, 60_000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const lifetimeTokens = useMemo(() => {
    if (!snap)
      return { input: 0, output: 0, cacheRead: 0, cacheCreate: 0, web: 0 };
    let input = 0,
      output = 0,
      cacheRead = 0,
      cacheCreate = 0,
      web = 0;
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

  // 30-day daily activity, padded so missing days show as zero bars.
  const dailyBars = useMemo(() => {
    if (!snap || snap.dailyActivity.length === 0)
      return [] as { date: string; messages: number }[];
    const byDate = new Map(
      snap.dailyActivity.map((d) => [d.date, d.messageCount] as const),
    );
    const out: { date: string; messages: number }[] = [];
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
    <div className="mx-auto w-full max-w-5xl p-3 md:p-5 space-y-4">
      <header className="flex items-center gap-2 flex-wrap">
        <Gauge size={16} className="text-primary" />
        <h2 className="text-base font-semibold">Usage</h2>
        {snap?.plan && (
          <span
            className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded border border-success/40 bg-success/10 text-success text-[10.5px] font-mono"
            title="Plan tier from ~/.claude/.credentials.json"
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
            cache: {formatTimeAgo(snap?.cacheUpdatedAt ?? null)}
          </span>
          <button
            type="button"
            onClick={() => void refresh(true)}
            disabled={refreshing}
            className="inline-flex items-center justify-center h-6 w-6 rounded-md border border-border text-muted-foreground hover:text-foreground hover:bg-accent disabled:opacity-40"
            title="Refresh"
            aria-label="Refresh usage"
          >
            <RefreshCw
              size={11}
              className={refreshing ? "animate-spin" : ""}
            />
          </button>
        </span>
      </header>

      {/* Live quota panels — same data claude.ai/settings/usage shows.
          Pulled from `/api/usage` server-side (which proxies oauth/usage
          when the bridge has a credentials.json). */}
      {snap?.quota && (
        <QuotaSections
          quota={snap.quota}
          onRefresh={() => void refresh(true)}
        />
      )}

      {error && !snap ? (
        <div className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs">
          <AlertTriangle
            size={13}
            className="mt-0.5 shrink-0 text-destructive"
          />
          <p className="text-foreground">
            Usage failed:{" "}
            <code className="font-mono text-[11px]">{error}</code>
          </p>
        </div>
      ) : loading && !snap ? (
        <div className="space-y-2">
          <Skeleton className="h-20 w-full rounded-md" />
          <Skeleton className="h-40 w-full rounded-md" />
        </div>
      ) : !snap || snap.source === "missing" ? (
        <EmptyState
          icon={Gauge}
          title="No stats yet"
          hint="Run `claude` and let it work for a bit — Claude Code writes ~/.claude/stats-cache.json once it has activity to report."
        />
      ) : (
        <>
          {/* Lifetime tiles */}
          <section className="grid grid-cols-2 sm:grid-cols-4 gap-2">
            <Tile
              icon={Activity}
              label="Total messages"
              value={fmt(snap.totalMessages)}
              hint={`${snap.totalSessions} session${
                snap.totalSessions === 1 ? "" : "s"
              }`}
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

          {/* Daily activity bars (last 30 days) — stepped div bars to
              match main's pattern. */}
          <section className="rounded-md border border-border bg-card p-3">
            <div className="mb-2 flex items-center justify-between">
              <h3 className="text-[12.5px] font-semibold">Daily activity</h3>
              <span className="text-[10.5px] text-muted-foreground">
                last 30 days · max {fmt(dailyMax)} msg/day
              </span>
            </div>
            <div className="flex items-end gap-[2px] h-20">
              {dailyBars.map((b) => {
                const ratio = b.messages / dailyMax;
                const cls =
                  b.messages === 0
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
            <div className="mt-1 flex justify-between text-[9.5px] font-mono text-fg-dim">
              <span>{dailyBars[0]?.date}</span>
              <span>{dailyBars[dailyBars.length - 1]?.date}</span>
            </div>
          </section>

          {/* Per-model breakdown — per-row card with progress bar */}
          <section className="rounded-md border border-border bg-card p-3">
            <h3 className="mb-2 text-[12.5px] font-semibold">By model</h3>
            {Object.keys(snap.modelUsage).length === 0 ? (
              <p className="text-[11px] italic text-muted-foreground">
                No per-model data yet.
              </p>
            ) : (
              <div className="space-y-2">
                {Object.entries(snap.modelUsage)
                  .sort((a, b) => modelTotal(b[1]) - modelTotal(a[1]))
                  .map(([id, m]) => {
                    const total = modelTotal(m);
                    const sharePct =
                      grandTotal > 0 ? (total / grandTotal) * 100 : 0;
                    return (
                      <div
                        key={id}
                        className="rounded-md border border-border/60 bg-background/40 p-2"
                      >
                        <div className="mb-1.5 flex items-baseline gap-2">
                          <code className="font-mono text-[12px] font-medium text-foreground">
                            {shortModel(id)}
                          </code>
                          <span className="text-[10.5px] tabular-nums text-muted-foreground">
                            {sharePct.toFixed(1)}% of all-model tokens
                          </span>
                          <span className="ml-auto text-[11px] tabular-nums text-foreground">
                            ${m.costUSD.toFixed(2)} · {compact(total)}
                          </span>
                        </div>
                        <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted/40">
                          <div
                            className="h-full bg-primary"
                            style={{ width: `${Math.max(1, sharePct)}%` }}
                          />
                        </div>
                        <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-[10.5px] sm:grid-cols-4">
                          <Stat
                            label="input"
                            value={compact(m.inputTokens)}
                            full={fmt(m.inputTokens)}
                          />
                          <Stat
                            label="output"
                            value={compact(m.outputTokens)}
                            full={fmt(m.outputTokens)}
                          />
                          <Stat
                            label="cache read"
                            value={compact(m.cacheReadInputTokens)}
                            full={fmt(m.cacheReadInputTokens)}
                          />
                          <Stat
                            label="cache create"
                            value={compact(m.cacheCreationInputTokens)}
                            full={fmt(m.cacheCreationInputTokens)}
                          />
                        </dl>
                      </div>
                    );
                  })}
              </div>
            )}
          </section>

          {/* Longest session trophy card */}
          {snap.longestSession && (
            <section className="flex items-start gap-3 rounded-md border border-border bg-card p-3">
              <Trophy
                size={14}
                className="mt-0.5 shrink-0 text-warning"
              />
              <div className="min-w-0 flex-1">
                <h3 className="text-[12.5px] font-semibold">Longest session</h3>
                <p className="mt-0.5 text-[11.5px] text-muted-foreground">
                  <span className="font-mono text-foreground">
                    {formatDuration(snap.longestSession.duration)}
                  </span>{" "}
                  · {fmt(snap.longestSession.messageCount)} messages ·{" "}
                  <span title={snap.longestSession.timestamp}>
                    {formatTimeAgo(snap.longestSession.timestamp)}
                  </span>
                </p>
                <code className="mt-1 block truncate font-mono text-[10.5px] text-fg-dim">
                  {snap.longestSession.sessionId}
                </code>
              </div>
            </section>
          )}

          <p className="text-[10.5px] text-muted-foreground text-center pt-1">
            First session{" "}
            {snap.firstSessionDate ? formatTimeAgo(snap.firstSessionDate) : "—"}
            {snap.lastComputedDate && (
              <> · stats recomputed {snap.lastComputedDate}</>
            )}
          </p>
        </>
      )}
    </div>
  );
}

function Tile({
  icon: Icon,
  label,
  value,
  hint,
}: {
  icon: LucideIcon;
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
        <div className="text-[10px] text-muted-foreground tabular-nums">
          {hint}
        </div>
      )}
    </div>
  );
}

function Stat({
  label,
  value,
  full,
}: {
  label: string;
  value: string;
  full: string;
}) {
  return (
    <div className="flex min-w-0 items-baseline gap-1" title={full}>
      <dt className="shrink-0 text-fg-dim">{label}</dt>
      <dd className="truncate font-mono tabular-nums text-foreground">
        {value}
      </dd>
    </div>
  );
}

/* ─────────────────────── quota panels ─────────────────────── */

interface QuotaRow {
  title: string;
  sub?: string;
  window: QuotaWindow | null;
  /** Hide the row entirely when the window is null. */
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
            : (row.sub ?? (w ? "" : "not available on this plan"))}
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
            Not enabled · run{" "}
            <code className="font-mono text-[11px]">/extra-usage</code> in
            claude
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
        <div className="text-[10.5px] tabular-nums text-muted-foreground">
          {extra.usedCredits != null && extra.monthlyLimit != null
            ? `${extra.usedCredits.toLocaleString()} / ${extra.monthlyLimit.toLocaleString()}${
                extra.currency ? ` ${extra.currency}` : ""
              }`
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
 * Three-section panel mirroring claude.ai/settings/usage.
 */
function QuotaSections({
  quota,
  onRefresh,
}: {
  quota: QuotaPanel;
  onRefresh: () => void;
}) {
  if (quota.error) {
    return (
      <div className="flex items-start gap-2 px-3 py-2 rounded-md border border-destructive/40 bg-destructive/5 text-[11.5px]">
        <AlertTriangle
          size={13}
          className="mt-0.5 shrink-0 text-destructive"
        />
        <p className="leading-snug text-foreground">
          Live quota unavailable:{" "}
          <code className="font-mono text-[11px]">{quota.error}</code>
        </p>
      </div>
    );
  }

  const weeklyRows: QuotaRow[] = [
    { title: "All models", window: quota.weeklyAllModels },
    { title: "Sonnet only", window: quota.weeklySonnet, hideWhenNull: true },
    { title: "Opus only", window: quota.weeklyOpus, hideWhenNull: true },
    {
      title: "Claude Design",
      window: quota.weeklyClaudeDesign,
      hideWhenNull: true,
    },
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
          {weeklyRows.map((r) => (
            <QuotaBar key={r.title} row={r} />
          ))}
        </div>
        <div className="flex items-center gap-1 pt-2 text-[10.5px] text-muted-foreground">
          <span>Last updated {formatTimeAgo(quota.fetchedAt)}</span>
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
