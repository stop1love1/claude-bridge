import { useMemo, useState } from "react";
import {
  Activity,
  ArrowDownToLine,
  ArrowUpFromLine,
  Database,
  Gauge,
  RefreshCw,
  Trophy,
  type LucideIcon,
} from "lucide-react";
import { useUsage } from "@/api/queries";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import type { UsageModel, UsageSnapshot } from "@/api/types";

function isSnapshot(v: unknown): v is UsageSnapshot {
  if (!v || typeof v !== "object") return false;
  return "modelUsage" in v && "totalSessions" in v;
}

function fmt(n: number): string {
  return n.toLocaleString();
}

function compact(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000)
    return (n / 1000).toFixed(n < 10_000 ? 2 : 1) + "K";
  if (n < 1_000_000_000)
    return (n / 1_000_000).toFixed(n < 10_000_000 ? 2 : 1) + "M";
  return (n / 1_000_000_000).toFixed(2) + "B";
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
  return `${day}d ago`;
}

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

export default function UsagePage() {
  const [forceTick, setForceTick] = useState(0);
  const { data, isLoading, refetch, isFetching } = useUsage(forceTick > 0);

  const snap = isSnapshot(data) ? data : null;

  const lifetime = useMemo(() => {
    let input = 0,
      output = 0,
      cacheRead = 0,
      cacheCreate = 0;
    if (snap) {
      for (const m of Object.values(snap.modelUsage)) {
        input += m.inputTokens;
        output += m.outputTokens;
        cacheRead += m.cacheReadInputTokens;
        cacheCreate += m.cacheCreationInputTokens;
      }
    }
    return { input, output, cacheRead, cacheCreate };
  }, [snap]);
  const grandTotal =
    lifetime.input + lifetime.output + lifetime.cacheRead + lifetime.cacheCreate;

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

  const refresh = () => {
    setForceTick((t) => t + 1);
    void refetch();
  };

  return (
    <div className="mx-auto w-full max-w-5xl px-6 py-10">
      <header className="mb-6 flex flex-wrap items-center gap-2">
        <Gauge size={18} className="text-accent" />
        <h1 className="font-mono text-display font-semibold tracking-tightish text-fg">
          usage
        </h1>
        {snap?.plan && (
          <span className="inline-flex items-center gap-1 rounded-full border border-status-done/40 bg-status-done/10 px-2 py-0.5 font-mono text-[10px] tracking-wideish text-status-done">
            {snap.plan.subscriptionType}
            {snap.plan.rateLimitTier && (
              <span className="opacity-70">· {snap.plan.rateLimitTier}</span>
            )}
          </span>
        )}
        <span className="ml-auto inline-flex items-center gap-2 font-mono text-micro tracking-wideish text-muted">
          <span title={snap?.cacheUpdatedAt ?? "no cache file"}>
            cache: {timeAgo(snap?.cacheUpdatedAt ?? null)}
          </span>
          <Button
            variant="ghost"
            size="iconSm"
            onClick={refresh}
            disabled={isFetching}
            title="force-refresh"
            aria-label="refresh"
          >
            <RefreshCw
              size={12}
              className={isFetching ? "animate-spin" : ""}
            />
          </Button>
        </span>
      </header>

      {isLoading && !snap ? (
        <div className="space-y-2">
          <Skeleton className="h-20 w-full rounded-sm" />
          <Skeleton className="h-40 w-full rounded-sm" />
        </div>
      ) : !snap || snap.source === "missing" ? (
        <EmptyState
          icon={Gauge}
          title="no sessions tracked yet"
          hint="once a Claude run completes, usage will accumulate here. Claude Code writes ~/.claude/stats-cache.json once it has activity to report."
        />
      ) : (
        <>
          {/* Lifetime tiles */}
          <section className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <Tile
              icon={Activity}
              label="messages"
              value={fmt(snap.totalMessages)}
              hint={`${snap.totalSessions} session${
                snap.totalSessions === 1 ? "" : "s"
              }`}
            />
            <Tile
              icon={ArrowUpFromLine}
              label="input tokens"
              value={compact(lifetime.input)}
              hint={fmt(lifetime.input)}
            />
            <Tile
              icon={ArrowDownToLine}
              label="output tokens"
              value={compact(lifetime.output)}
              hint={fmt(lifetime.output)}
            />
            <Tile
              icon={Database}
              label="cache read"
              value={compact(lifetime.cacheRead)}
              hint={`${compact(lifetime.cacheCreate)} created`}
            />
          </section>

          {/* Daily activity SVG bar chart */}
          <section className="mt-4 rounded-sm border border-border bg-surface p-3">
            <div className="mb-2 flex items-center justify-between">
              <h3 className="font-mono text-micro uppercase tracking-wideish text-fg">
                daily activity
              </h3>
              <span className="font-mono text-[10px] tracking-wideish text-muted">
                last 30 days · max {fmt(dailyMax)} msg/day
              </span>
            </div>
            <DailyBars bars={dailyBars} max={dailyMax} />
            <div className="mt-1 flex justify-between font-mono text-[10px] text-muted-2">
              <span>{dailyBars[0]?.date}</span>
              <span>{dailyBars[dailyBars.length - 1]?.date}</span>
            </div>
          </section>

          {/* Per-model table */}
          <section className="mt-4 rounded-sm border border-border bg-surface p-3">
            <h3 className="mb-2 font-mono text-micro uppercase tracking-wideish text-fg">
              by model
            </h3>
            {Object.keys(snap.modelUsage).length === 0 ? (
              <p className="text-small italic text-muted">
                no per-model data yet.
              </p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-small">
                  <thead>
                    <tr className="border-b border-border text-left">
                      <Th>model</Th>
                      <Th>input</Th>
                      <Th>output</Th>
                      <Th>cache read</Th>
                      <Th>cache create</Th>
                      <Th>cost</Th>
                      <Th>share</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {Object.entries(snap.modelUsage)
                      .sort((a, b) => modelTotal(b[1]) - modelTotal(a[1]))
                      .map(([id, m]) => {
                        const total = modelTotal(m);
                        const share =
                          grandTotal > 0 ? (total / grandTotal) * 100 : 0;
                        return (
                          <tr
                            key={id}
                            className="border-b border-border/60 last:border-0"
                          >
                            <Td className="font-mono">{shortModel(id)}</Td>
                            <Td className="tabular-nums">
                              {compact(m.inputTokens)}
                            </Td>
                            <Td className="tabular-nums">
                              {compact(m.outputTokens)}
                            </Td>
                            <Td className="tabular-nums">
                              {compact(m.cacheReadInputTokens)}
                            </Td>
                            <Td className="tabular-nums">
                              {compact(m.cacheCreationInputTokens)}
                            </Td>
                            <Td className="tabular-nums">
                              ${m.costUSD.toFixed(2)}
                            </Td>
                            <Td className="tabular-nums">
                              {share.toFixed(1)}%
                            </Td>
                          </tr>
                        );
                      })}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          {/* Top sessions / longest session */}
          {snap.longestSession && (
            <section className="mt-4 flex items-start gap-3 rounded-sm border border-border bg-surface p-3">
              <Trophy
                size={14}
                className="mt-0.5 shrink-0 text-status-doing"
              />
              <div className="min-w-0 flex-1">
                <h3 className="font-mono text-micro uppercase tracking-wideish text-fg">
                  longest session
                </h3>
                <p className="mt-0.5 text-small text-muted">
                  <span className="font-mono text-fg">
                    {formatDuration(snap.longestSession.duration)}
                  </span>{" "}
                  · {fmt(snap.longestSession.messageCount)} messages ·{" "}
                  <span title={snap.longestSession.timestamp}>
                    {timeAgo(snap.longestSession.timestamp)}
                  </span>
                </p>
                <code className="mt-1 block truncate font-mono text-[10px] text-muted-2">
                  {snap.longestSession.sessionId}
                </code>
              </div>
            </section>
          )}

          <p className="mt-6 text-center font-mono text-[10px] tracking-wideish text-muted-2">
            first session{" "}
            {snap.firstSessionDate ? timeAgo(snap.firstSessionDate) : "—"}
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
    <div className="rounded-sm border border-border bg-surface p-3">
      <div className="flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-wideish text-muted">
        <Icon size={11} className="text-accent" />
        {label}
      </div>
      <div className="mt-1.5 font-mono text-base font-semibold tabular-nums text-fg">
        {value}
      </div>
      {hint && (
        <div className="font-mono text-[10px] tabular-nums text-muted-2">
          {hint}
        </div>
      )}
    </div>
  );
}

function Th({ children }: { children: React.ReactNode }) {
  return (
    <th className="px-2 py-1.5 font-mono text-[10px] uppercase tracking-wideish text-muted">
      {children}
    </th>
  );
}
function Td({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <td className={`px-2 py-1.5 text-fg ${className ?? ""}`}>{children}</td>
  );
}

/**
 * Tiny inline-SVG bar chart — avoids pulling recharts in just for a
 * 30-bar histogram. ViewBox is fixed to 30×100 so each bar lives in a
 * 1-unit-wide slot; height in % is computed from the running max.
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
            className="text-accent"
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
