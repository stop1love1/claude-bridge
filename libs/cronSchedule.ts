/**
 * Schedule math for workflow cron jobs — pure, dependency-free, and
 * unit-tested in isolation.
 *
 * We intentionally support only two shapes (the answers to the design
 * questions): a fixed INTERVAL and a DAILY time-of-day. Both cover the
 * common "every N minutes" / "at 09:00 each day" needs without a full
 * 5-field cron parser. `computeNextRun` is the single source of truth for
 * when a workflow fires next; the scheduler persists the result as
 * `nextRunAt` and compares it against the wall clock each tick.
 *
 * Daily times are interpreted in the SERVER's LOCAL timezone (the bridge
 * runs on one operator machine — local time is what the human means by
 * "09:00").
 */

export type CronSchedule =
  | { kind: "interval"; everyMs: number }
  | { kind: "daily"; time: string }; // "HH:MM", 24h, local time

/** Floor for interval schedules — guards against a busy-loop of spawns. */
export const MIN_INTERVAL_MS = 60_000;

const HHMM_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

/**
 * Validate a schedule object. Returns null when valid, else a short
 * human-readable reason (surfaced to the UI / API caller).
 */
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

/**
 * Epoch ms of the next fire time STRICTLY AFTER `afterMs`.
 *
 *   - interval: `afterMs + everyMs` (one full interval — never fires
 *     immediately on creation, which is the intuitive "every N" behavior).
 *   - daily: the next occurrence of HH:MM in local time after `afterMs`
 *     (today if it hasn't passed yet, otherwise tomorrow).
 *
 * Returns NaN for an invalid schedule (caller should validate first).
 */
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
    // Strictly after — if today's slot already passed (or is exactly
    // now), roll to tomorrow.
    if (candidate.getTime() <= afterMs) {
      candidate.setDate(candidate.getDate() + 1);
    }
    return candidate.getTime();
  }
  return NaN;
}

/** One-line description for the UI ("every 30m", "daily at 09:00"). */
export function describeSchedule(s: CronSchedule): string {
  if (s.kind === "interval") {
    const mins = Math.round(s.everyMs / 60_000);
    if (mins % 1440 === 0) return `every ${mins / 1440}d`;
    if (mins % 60 === 0) return `every ${mins / 60}h`;
    return `every ${mins}m`;
  }
  return `daily at ${s.time}`;
}
