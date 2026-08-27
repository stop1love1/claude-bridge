
export type CronSchedule =
  | { kind: "interval"; everyMs: number }
  | { kind: "daily"; time: string };

export const MIN_INTERVAL_MS = 60_000;

const HHMM_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

export function validateSchedule(s: unknown): string | null {
  if (!s || typeof s !== "object") return "schedule required";
  const v = s as Partial<CronSchedule>;
  if (v.kind === "interval") {
    const ms = (v as { everyMs?: unknown }).everyMs;
    if (typeof ms !== "number" || !Number.isFinite(ms)) return "everyMs must be a number";
    if (ms < MIN_INTERVAL_MS) return `interval must be ≥ ${MIN_INTERVAL_MS / 1000}s`;
    return null;
  }
  if (v.kind === "daily") {
    const t = (v as { time?: unknown }).time;
    if (typeof t !== "string" || !HHMM_RE.test(t)) return "time must be HH:MM (00:00–23:59)";
    return null;
  }
  return "kind must be 'interval' or 'daily'";
}

export function computeNextRun(schedule: CronSchedule, afterMs: number): number {
  if (schedule.kind === "interval") {
    const step = Math.max(MIN_INTERVAL_MS, schedule.everyMs);
    return afterMs + step;
  }
  if (schedule.kind === "daily") {
    const m = HHMM_RE.exec(schedule.time);
    if (!m) return NaN;
    const hh = Number(m[1]);
    const mm = Number(m[2]);
    const d = new Date(afterMs);
    const candidate = new Date(
      d.getFullYear(),
      d.getMonth(),
      d.getDate(),
      hh,
      mm,
      0,
      0,
    );
    if (candidate.getTime() <= afterMs) {
      candidate.setDate(candidate.getDate() + 1);
    }
    return candidate.getTime();
  }
  return NaN;
}

export function describeSchedule(s: CronSchedule): string {
  if (s.kind === "interval") {
    const mins = Math.round(s.everyMs / 60_000);
    if (mins % 1440 === 0) return `every ${mins / 1440}d`;
    if (mins % 60 === 0) return `every ${mins / 60}h`;
    return `every ${mins}m`;
  }
  return `daily at ${s.time}`;
}
