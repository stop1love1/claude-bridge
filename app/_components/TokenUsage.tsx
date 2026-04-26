"use client";

import { ArrowDown, ArrowUp, Database, Coins } from "lucide-react";

export interface TokenTotals {
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  turns: number;
}

const ZERO: TokenTotals = {
  inputTokens: 0, outputTokens: 0,
  cacheCreationTokens: 0, cacheReadTokens: 0, turns: 0,
};

/**
 * Format an integer token count as a compact human label:
 *   524 → "524"
 *   12_400 → "12.4k"
 *   3_200_000 → "3.2M"
 */
export function formatTokens(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0";
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(n < 10_000_000 ? 2 : 1)}M`;
}

export function TokenUsage({
  totals,
  variant = "compact",
  className,
  title,
}: {
  totals?: TokenTotals | null;
  /**
   * `compact` → single pill (in / out / cache).
   * `detailed` → 3 separate pills with icons + labels (used in TaskDetail).
   */
  variant?: "compact" | "detailed";
  className?: string;
  title?: string;
}) {
  const t = totals ?? ZERO;
  const tooltip =
    title ??
    `${t.turns} turn${t.turns === 1 ? "" : "s"} · ` +
      `${t.inputTokens.toLocaleString()} input · ` +
      `${t.outputTokens.toLocaleString()} output · ` +
      `${t.cacheReadTokens.toLocaleString()} cache read · ` +
      `${t.cacheCreationTokens.toLocaleString()} cache write`;

  if (variant === "compact") {
    return (
      <span
        className={`inline-flex items-center gap-1.5 rounded-md border border-border bg-secondary px-1.5 h-6 text-[10px] font-mono text-muted-foreground ${className ?? ""}`}
        title={tooltip}
      >
        <Coins size={10} className="text-info" />
        <span className="inline-flex items-center gap-0.5">
          <ArrowUp size={9} className="text-warning" />
          {formatTokens(t.inputTokens)}
        </span>
        <span className="inline-flex items-center gap-0.5">
          <ArrowDown size={9} className="text-success" />
          {formatTokens(t.outputTokens)}
        </span>
        {t.cacheReadTokens > 0 && (
          <span className="inline-flex items-center gap-0.5 opacity-80">
            <Database size={9} />
            {formatTokens(t.cacheReadTokens)}
          </span>
        )}
      </span>
    );
  }

  return (
    <div className={`flex items-center gap-2 flex-wrap text-[11px] ${className ?? ""}`} title={tooltip}>
      <span className="inline-flex items-center gap-1 rounded-full bg-warning/10 text-warning px-2 py-0.5 font-mono">
        <ArrowUp size={11} />
        {formatTokens(t.inputTokens)}
        <span className="text-warning/70 ml-0.5">in</span>
      </span>
      <span className="inline-flex items-center gap-1 rounded-full bg-success/10 text-success px-2 py-0.5 font-mono">
        <ArrowDown size={11} />
        {formatTokens(t.outputTokens)}
        <span className="text-success/70 ml-0.5">out</span>
      </span>
      {t.cacheReadTokens > 0 && (
        <span className="inline-flex items-center gap-1 rounded-full bg-info/10 text-info px-2 py-0.5 font-mono">
          <Database size={11} />
          {formatTokens(t.cacheReadTokens)}
          <span className="text-info/70 ml-0.5">cache</span>
        </span>
      )}
      <span className="text-fg-dim font-mono">
        {t.turns} {t.turns === 1 ? "turn" : "turns"}
      </span>
    </div>
  );
}
