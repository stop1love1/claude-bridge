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

/**
 * Compact "time ago" — same shape as `relTime` but always trails with
 * " ago" so quota / cache lines read naturally ("cache: 5m ago"). Falls
 * back to the raw input when the timestamp won't parse so debugging
 * stays possible.
 */
export function formatTimeAgo(input: string | null | undefined): string {
  if (!input) return "never";
  const t = Date.parse(input);
  if (Number.isNaN(t)) return input;
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
 * "Resets in 55 min" / "Resets Sat 9:00 PM" shape — matches claude.ai's
 * settings page. Within 24h we show urgency ("in 55 min"), beyond that
 * we switch to the calendar form so the operator can plan around the
 * cap. Local timezone since the operator is reading it.
 */
export function formatResetsAt(input: string | null | undefined): string {
  if (!input) return "—";
  const d = new Date(input);
  if (!Number.isFinite(d.getTime())) return input;
  const diffMs = d.getTime() - Date.now();
  if (diffMs < 24 * 60 * 60 * 1000 && diffMs > 0) {
    const min = Math.round(diffMs / 60_000);
    if (min < 60) return `in ${min} min`;
    const h = Math.floor(min / 60);
    const m = min - h * 60;
    return m ? `in ${h}h ${m}m` : `in ${h}h`;
  }
  const wd = d.toLocaleDateString(undefined, { weekday: "short" });
  const t = d.toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
  return `${wd} ${t}`;
}

/**
 * "1h 10m", "45s", "3d 2h" — used by the longest-session card in the
 * usage page where dropping a date library would be overkill.
 */
export function formatDuration(ms: number): string {
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ${sec - min * 60}s`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ${min - hr * 60}m`;
  const day = Math.floor(hr / 24);
  return `${day}d ${hr - day * 24}h`;
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
