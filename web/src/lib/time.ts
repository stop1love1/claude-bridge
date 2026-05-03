// Relative time formatter. Operator-facing, terse: "12s ago", "4m",
// "3h", "2d". Anything older falls back to a YYYY-MM-DD stamp so the
// list stays scannable.

export function relTime(input: string | null | undefined): string {
  if (!input) return "—";
  const t = Date.parse(input);
  if (Number.isNaN(t)) return "—";
  const diff = Math.max(0, Date.now() - t);
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  if (d < 14) return `${d}d`;
  // Use YYYY-MM-DD in UTC. Local-zone formatting would shift task ids
  // (which are minted in UTC) and confuse cross-timezone operators.
  return new Date(t).toISOString().slice(0, 10);
}

export function durationMs(start: string | null, end: string | null): string {
  if (!start) return "—";
  const s = Date.parse(start);
  const e = end ? Date.parse(end) : Date.now();
  if (Number.isNaN(s) || Number.isNaN(e)) return "—";
  const ms = Math.max(0, e - s);
  if (ms < 1000) return `${ms}ms`;
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  const remSec = sec % 60;
  if (min < 60) return `${min}m ${remSec}s`;
  const h = Math.floor(min / 60);
  return `${h}h ${min % 60}m`;
}
