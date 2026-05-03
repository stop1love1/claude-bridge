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
import { Button } from "@/components/ui/button";
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
  if (pct >= 85) return "bg-status-blocked";
  if (pct >= 60) return "bg-status-doing";
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
    <div className="mx-auto w-full max-w-5xl px-6 py-10">
      <header className="mb-6 flex flex-wrap items-center gap-2">
        <Gauge size={18} className="text-primary" />
        <h1 className="font-mono text-display font-semibold tracking-tightish text-foreground">
          usage
        </h1>
        {snap?.plan && (
          <span
            className="inline-flex items-center gap-1 rounded-full border border-status-done/40 bg-status-done/10 px-2 py-0.5 font-mono text-[10px] tracking-wideish text-status-done"
            title="plan tier from ~/.claude/.credentials.json"
          >
            <Sparkles size={10} />
            {snap.plan.subscriptionType}
            {snap.plan.rateLimitTier && (
              <span className="opacity-70">· {snap.plan.rateLimitTier}</span>
            )}
          </span>
        )}
        <span className="ml-auto inline-flex items-center gap-2 font-mono text-micro tracking-wideish text-muted-foreground">
          <span title={snap?.cacheUpdatedAt ?? "no cache file"}>
            cache: {formatTimeAgo(snap?.cacheUpdatedAt ?? null)}
          </span>
          <Button
            variant="ghost"
            size="iconSm"
            onClick={() => void refresh(true)}
            disabled={refreshing}
            title="force-refresh"
            aria-label="refresh"
          >
            <RefreshCw
              size={12}
              className={refreshing ? "animate-spin" : ""}
            />
          </Button>
        </span>
      </header>

      {/* Live quota panels — same data claude.ai/settings/usage shows.
          Pulled from `/api/usage` server-side (which proxies oauth/usage
          when the bridge has a credentials.json). When the field is null
          we fall back to a placeholder card so the operator knows whether
          the gap is "no plan" or "endpoint not yet ported." */}
      <QuotaSections
        quota={snap?.quota ?? null}
        onRefresh={() => void refresh(true)}
      />

      {error && !snap ? (
        <div className="mt-4 flex items-start gap-2 rounded-sm border border-status-blocked/40 bg-status-blocked/10 px-3 py-2 text-small">
          <AlertTriangle
            size={13}
            className="mt-0.5 shrink-0 text-status-blocked"
          />
          <p className="text-foreground">
            usage failed:{" "}
            <code className="font-mono text-[11px]">{error}</code>
          </p>
        </div>
      ) : loading && !snap ? (
        <div className="mt-4 space-y-2">
          <Skeleton className="h-20 w-full rounded-sm" />
          <Skeleton className="h-40 w-full rounded-sm" />
        </div>
      ) : !snap || snap.source === "missing" ? (
        <EmptyState
          icon={Gauge}
          title="no sessions tracked yet"
          hint="once a Claude run completes, usage will accumulate here. Claude Code writes ~/.claude/stats-cache.json once it has activity to report."
          className="mt-4"
        />
      ) : (
        <div className="mt-4 space-y-4">
          {/* Lifetime tiles */}
          <section className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <Tile
              icon={Activity}
              label="messages"
              value={fmt(snap.totalMessages)}
              hint={`${snap.totalSessions} session${
                snap.totalSessions === 1 ? "" : "s"
              } · ${fmt(lifetimeTokens.web)} web search${
                lifetimeTokens.web === 1 ? "" : "es"
              }`}
            />
            <Tile
              icon={ArrowUpFromLine}
              label="input tokens"
              value={compact(lifetimeTokens.input)}
              hint={fmt(lifetimeTokens.input)}
            />
            <Tile
              icon={ArrowDownToLine}
              label="output tokens"
              value={compact(lifetimeTokens.output)}
              hint={fmt(lifetimeTokens.output)}
            />
            <Tile
              icon={Database}
              label="cache read"
              value={compact(lifetimeTokens.cacheRead)}
              hint={`${compact(lifetimeTokens.cacheCreate)} created`}
            />
          </section>

          {/* Daily activity SVG bar chart */}
          <section className="rounded-sm border border-border bg-card p-3">
            <div className="mb-2 flex items-center justify-between">
              <h3 className="font-mono text-micro uppercase tracking-wideish text-foreground">
                daily activity
              </h3>
              <span className="font-mono text-[10px] tracking-wideish text-muted-foreground">
                last 30 days · max {fmt(dailyMax)} msg/day
              </span>
            </div>
            <DailyBars bars={dailyBars} max={dailyMax} />
            <div className="mt-1 flex justify-between font-mono text-[10px] text-fg-dim">
              <span>{dailyBars[0]?.date}</span>
              <span>{dailyBars[dailyBars.length - 1]?.date}</span>
            </div>
          </section>

          {/* Per-model breakdown — per-row card with progress bar */}
          <section className="rounded-sm border border-border bg-card p-3">
            <h3 className="mb-2 font-mono text-micro uppercase tracking-wideish text-foreground">
              by model
            </h3>
            {Object.keys(snap.modelUsage).length === 0 ? (
              <p className="text-small italic text-muted-foreground">
                no per-model data yet.
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
                        className="rounded-sm border border-border/60 bg-background/40 p-2"
                      >
                        <div className="mb-1.5 flex items-baseline gap-2">
                          <code className="font-mono text-small font-medium text-foreground">
                            {shortModel(id)}
                          </code>
                          <span className="font-mono text-[10px] tabular-nums text-muted-foreground">
                            {sharePct.toFixed(1)}% of all-model tokens
                          </span>
                          <span className="ml-auto font-mono text-[11px] tabular-nums text-foreground">
                            ${m.costUSD.toFixed(2)} · {compact(total)}
                          </span>
                        </div>
                        <div className="h-1.5 w-full overflow-hidden rounded-full bg-secondary">
                          <div
                            className="h-full bg-primary"
                            style={{ width: `${Math.max(1, sharePct)}%` }}
                          />
                        </div>
                        <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 font-mono text-[10px] sm:grid-cols-4">
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
            <section className="flex items-start gap-3 rounded-sm border border-border bg-card p-3">
              <Trophy
                size={14}
                className="mt-0.5 shrink-0 text-status-doing"
              />
              <div className="min-w-0 flex-1">
                <h3 className="font-mono text-micro uppercase tracking-wideish text-foreground">
                  longest session
                </h3>
                <p className="mt-0.5 text-small text-muted-foreground">
                  <span className="font-mono text-foreground">
                    {formatDuration(snap.longestSession.duration)}
                  </span>{" "}
                  · {fmt(snap.longestSession.messageCount)} messages ·{" "}
                  <span title={snap.longestSession.timestamp}>
                    {formatTimeAgo(snap.longestSession.timestamp)}
                  </span>
                </p>
                <code className="mt-1 block truncate font-mono text-[10px] text-fg-dim">
                  {snap.longestSession.sessionId}
                </code>
              </div>
            </section>
          )}

          <p className="pt-1 text-center font-mono text-[10px] tracking-wideish text-fg-dim">
            first session{" "}
            {snap.firstSessionDate ? formatTimeAgo(snap.firstSessionDate) : "—"}
            {snap.lastComputedDate && (
              <> · stats recomputed {snap.lastComputedDate}</>
            )}
          </p>
        </div>
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
    <div className="rounded-sm border border-border bg-card p-3">
      <div className="flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-wideish text-muted-foreground">
        <Icon size={11} className="text-primary" />
        {label}
      </div>
      <div className="mt-1.5 font-mono text-base font-semibold tabular-nums text-foreground">
        {value}
      </div>
      {hint && (
        <div className="font-mono text-[10px] tabular-nums text-fg-dim">
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

/**
 * Tiny inline-SVG bar chart — avoids pulling recharts in just for a
 * 30-bar histogram.
 */
function DailyBars({
  bars,
  max,
}: {
  bars: { date: string; messages: number }[];
  max: number;
}) {
  if (bars.length === 0) return null;
  const W = bars.length;
  return (
    <svg
      viewBox={`0 0 ${W} 100`}
      preserveAspectRatio="none"
      className="h-20 w-full"
    >
      {bars.map((b, i) => {
        const ratio = b.messages / max;
        const height = Math.max(2, ratio * 100);
        const opacity = b.messages === 0 ? 0.25 : 0.4 + ratio * 0.6;
        return (
          <rect
            key={b.date}
            x={i + 0.1}
            y={100 - height}
            width={0.8}
            height={height}
            fill="currentColor"
            opacity={opacity}
            className="text-primary"
          >
            <title>
              {b.date}: {fmt(b.messages)} message
              {b.messages === 1 ? "" : "s"}
            </title>
          </rect>
        );
      })}
    </svg>
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
        <div className="truncate text-small font-medium text-foreground">
          {row.title}
        </div>
        <div className="truncate text-[10.5px] text-muted-foreground">
          {w?.resetsAt
            ? `resets ${formatResetsAt(w.resetsAt)}`
            : (row.sub ?? (w ? "" : "not available on this plan"))}
        </div>
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-secondary">
        {w && (
          <div
            className={`h-full ${utilizationColor(pct)} transition-all`}
            style={{ width: `${Math.max(1, pct)}%` }}
          />
        )}
      </div>
      <div className="min-w-[64px] whitespace-nowrap text-right font-mono text-[11px] tabular-nums text-muted-foreground">
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
          <div className="text-small font-medium text-foreground">
            extra usage
          </div>
          <div className="text-[10.5px] text-muted-foreground">
            not enabled · run{" "}
            <code className="font-mono text-[11px]">/extra-usage</code> in
            claude
          </div>
        </div>
        <div className="h-2 rounded-full bg-secondary" />
        <div className="min-w-[64px] whitespace-nowrap text-right font-mono text-[11px] tabular-nums text-muted-foreground">
          off
        </div>
      </div>
    );
  }
  const pct = Math.min(100, Math.max(0, extra.utilization ?? 0));
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,2fr)_auto] items-center gap-3 py-2">
      <div className="min-w-0">
        <div className="text-small font-medium text-foreground">
          extra usage
        </div>
        <div className="font-mono text-[10.5px] tabular-nums text-muted-foreground">
          {extra.usedCredits != null && extra.monthlyLimit != null
            ? `${extra.usedCredits.toLocaleString()} / ${extra.monthlyLimit.toLocaleString()}${
                extra.currency ? ` ${extra.currency}` : ""
              }`
            : "overage credits"}
        </div>
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-secondary">
        <div
          className={`h-full ${utilizationColor(pct)} transition-all`}
          style={{ width: `${Math.max(1, pct)}%` }}
        />
      </div>
      <div className="min-w-[64px] whitespace-nowrap text-right font-mono text-[11px] tabular-nums text-muted-foreground">
        {pct.toFixed(0)}% used
      </div>
    </div>
  );
}

/**
 * Three-section panel mirroring claude.ai/settings/usage. When `quota`
 * is null we render a placeholder card so the operator knows whether
 * the bridge endpoint is missing or just hasn't fetched yet.
 */
function QuotaSections({
  quota,
  onRefresh,
}: {
  quota: QuotaPanel | null;
  onRefresh: () => void;
}) {
  if (!quota) {
    return (
      <div className="rounded-sm border border-dashed border-border bg-card/50 p-4 text-small text-muted-foreground">
        <div className="mb-1 flex items-center gap-2">
          <Gauge size={13} className="text-primary" />
          <h3 className="font-mono text-micro uppercase tracking-wideish text-foreground">
            plan usage limits
          </h3>
        </div>
        <p>
          quota data unavailable — sign in to Anthropic on this machine
          (claude code stores credentials in{" "}
          <span className="font-mono text-foreground">
            ~/.claude/.credentials.json
          </span>
          ) to surface plan limits, or run{" "}
          <code className="font-mono text-[11px]">/extra-usage</code> in
          claude to enable extra-usage display.
        </p>
      </div>
    );
  }

  if (quota.error) {
    return (
      <div className="flex items-start gap-2 rounded-sm border border-status-blocked/40 bg-status-blocked/5 px-3 py-2 text-small">
        <AlertTriangle
          size={13}
          className="mt-0.5 shrink-0 text-status-blocked"
        />
        <p className="leading-snug text-foreground">
          live quota unavailable:{" "}
          <code className="font-mono text-[11px]">{quota.error}</code>
        </p>
      </div>
    );
  }

  const weeklyRows: QuotaRow[] = [
    { title: "all models", window: quota.weeklyAllModels },
    { title: "sonnet only", window: quota.weeklySonnet, hideWhenNull: true },
    { title: "opus only", window: quota.weeklyOpus, hideWhenNull: true },
    {
      title: "claude design",
      window: quota.weeklyClaudeDesign,
      hideWhenNull: true,
    },
    { title: "oauth apps", window: quota.weeklyOauthApps, hideWhenNull: true },
    { title: "cowork", window: quota.weeklyCowork, hideWhenNull: true },
  ];

  return (
    <div className="space-y-5 rounded-sm border border-border bg-card p-4">
      <section>
        <h3 className="mb-1 font-mono text-micro uppercase tracking-wideish text-foreground">
          plan usage limits
        </h3>
        <QuotaBar row={{ title: "current session", window: quota.fiveHour }} />
      </section>

      <section>
        <h3 className="mb-1 font-mono text-micro uppercase tracking-wideish text-foreground">
          weekly limits
        </h3>
        <div className="divide-y divide-border/40">
          {weeklyRows.map((r) => (
            <QuotaBar key={r.title} row={r} />
          ))}
        </div>
        <div className="flex items-center gap-1 pt-2 font-mono text-[10.5px] tracking-wideish text-muted-foreground">
          <span>last updated {formatTimeAgo(quota.fetchedAt)}</span>
          <button
            type="button"
            onClick={onRefresh}
            className="inline-flex h-5 w-5 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
            title="refresh"
            aria-label="refresh quota"
          >
            <RefreshCw size={10} />
          </button>
        </div>
      </section>

      {quota.extraUsage && (
        <section>
          <h3 className="mb-1 font-mono text-micro uppercase tracking-wideish text-foreground">
            additional features
          </h3>
          <ExtraUsageBar extra={quota.extraUsage} />
        </section>
      )}
    </div>
  );
}
