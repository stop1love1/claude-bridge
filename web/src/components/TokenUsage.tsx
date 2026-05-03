import { ArrowDown, ArrowUp, Database, Coins } from "lucide-react";
import { cn } from "@/lib/cn";

// Compact + detailed token usage badges. Used in SessionLog header and
// TaskDetail header to surface input/output/cache totals for a run.
// `cacheCreate` (write) is shown only in `detailed` mode; `compact`
// keeps the strip narrow.

export interface TokenTotals {
  input: number;
  output: number;
  cacheCreate?: number;
  cacheRead?: number;
  /** Optional turn count surfaced in the tooltip/detailed view. */
  turns?: number;
}

const ZERO: Required<TokenTotals> = {
  input: 0,
  output: 0,
  cacheCreate: 0,
  cacheRead: 0,
  turns: 0,
};

/**
 * Format an integer token count as a compact label:
 *   524 → "524"
 *   12_400 → "12.4K"
 *   3_200_000 → "3.2M"
 */
export function formatTokens(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0";
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 2 : 1)}K`;
  return `${(n / 1_000_000).toFixed(n < 10_000_000 ? 2 : 1)}M`;
}

export function TokenUsage({
  totals,
  variant = "compact",
  className,
  title,
}: {
  totals?: TokenTotals | null;
  variant?: "compact" | "detailed";
  className?: string;
  title?: string;
}) {
  const t: Required<TokenTotals> = {
    input: totals?.input ?? 0,
    output: totals?.output ?? 0,
    cacheCreate: totals?.cacheCreate ?? 0,
    cacheRead: totals?.cacheRead ?? 0,
    turns: totals?.turns ?? 0,
  };
  const _ = ZERO; void _;
  const tooltip =
    title ??
    `${t.input.toLocaleString()} input · ` +
      `${t.output.toLocaleString()} output · ` +
      `${t.cacheRead.toLocaleString()} cache read · ` +
      `${t.cacheCreate.toLocaleString()} cache write` +
      (t.turns ? ` · ${t.turns} turn${t.turns === 1 ? "" : "s"}` : "");

  if (variant === "compact") {
    return (
      <span
        className={cn(
          "inline-flex items-center gap-1.5 rounded-md border border-border bg-secondary px-1.5 h-6 text-[10px] font-mono text-muted-foreground",
          className,
        )}
        title={tooltip}
      >
        <Coins size={10} className="text-info" />
        <span className="inline-flex items-center gap-0.5 text-foreground">
          {formatTokens(t.input)}
          <span className="text-muted-foreground">in</span>
        </span>
        <span className="inline-flex items-center gap-0.5 text-foreground">
          {formatTokens(t.output)}
          <span className="text-muted-foreground">out</span>
        </span>
        {t.cacheRead > 0 && (
          <span className="inline-flex items-center gap-0.5 opacity-80">
            <Database size={9} />
            {formatTokens(t.cacheRead)}
          </span>
        )}
      </span>
    );
  }

  return (
    <div
      className={cn("flex items-center gap-2 flex-wrap text-[11px]", className)}
      title={tooltip}
    >
      <span className="inline-flex items-center gap-1 rounded-full bg-warning/10 text-warning px-2 py-0.5 font-mono">
        <ArrowUp size={11} />
        {formatTokens(t.input)}
        <span className="text-warning/70 ml-0.5">in</span>
      </span>
      <span className="inline-flex items-center gap-1 rounded-full bg-success/10 text-success px-2 py-0.5 font-mono">
        <ArrowDown size={11} />
        {formatTokens(t.output)}
        <span className="text-success/70 ml-0.5">out</span>
      </span>
      {t.cacheRead > 0 && (
        <span className="inline-flex items-center gap-1 rounded-full bg-info/10 text-info px-2 py-0.5 font-mono">
          <Database size={11} />
          {formatTokens(t.cacheRead)}
          <span className="text-info/70 ml-0.5">cache</span>
        </span>
      )}
      {t.cacheCreate > 0 && (
        <span className="inline-flex items-center gap-1 rounded-full bg-info/5 text-info/80 px-2 py-0.5 font-mono">
          <Database size={11} />
          {formatTokens(t.cacheCreate)}
          <span className="text-info/70 ml-0.5">cw</span>
        </span>
      )}
      {t.turns > 0 && (
        <span className="text-muted-foreground font-mono">
          {t.turns} {t.turns === 1 ? "turn" : "turns"}
        </span>
      )}
    </div>
  );
}
