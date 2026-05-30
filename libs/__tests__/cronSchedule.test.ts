import { describe, expect, it } from "vitest";
import {
  computeNextRun,
  describeSchedule,
  MIN_INTERVAL_MS,
  validateSchedule,
  type CronSchedule,
} from "../cronSchedule";

describe("validateSchedule", () => {
  it("accepts a valid interval", () => {
    expect(validateSchedule({ kind: "interval", everyMs: 60_000 })).toBeNull();
    expect(validateSchedule({ kind: "interval", everyMs: 3_600_000 })).toBeNull();
  });

  it("rejects an interval below the floor", () => {
    expect(validateSchedule({ kind: "interval", everyMs: 1000 })).toMatch(/interval must be/);
    expect(validateSchedule({ kind: "interval", everyMs: "x" as unknown as number })).toMatch(/number/);
  });

  it("accepts a valid daily time and rejects malformed ones", () => {
    expect(validateSchedule({ kind: "daily", time: "00:00" })).toBeNull();
    expect(validateSchedule({ kind: "daily", time: "23:59" })).toBeNull();
    expect(validateSchedule({ kind: "daily", time: "9:00" })).toMatch(/HH:MM/);
    expect(validateSchedule({ kind: "daily", time: "24:00" })).toMatch(/HH:MM/);
    expect(validateSchedule({ kind: "daily", time: "12:60" })).toMatch(/HH:MM/);
  });

  it("rejects unknown / missing kinds", () => {
    expect(validateSchedule(null)).toMatch(/required/);
    expect(validateSchedule({ kind: "weekly" })).toMatch(/kind/);
  });
});

describe("computeNextRun — interval", () => {
  it("adds one full interval (never fires immediately)", () => {
    const base = 1_000_000_000_000;
    expect(computeNextRun({ kind: "interval", everyMs: 60_000 }, base)).toBe(base + 60_000);
  });

  it("clamps a sub-floor interval up to the floor", () => {
    const base = 0;
    expect(computeNextRun({ kind: "interval", everyMs: 1 }, base)).toBe(base + MIN_INTERVAL_MS);
  });
});

describe("computeNextRun — daily", () => {
  it("returns a future time whose local HH:MM matches", () => {
    const after = new Date(2026, 4, 30, 8, 0, 0).getTime(); // local 08:00
    const next = computeNextRun({ kind: "daily", time: "09:00" }, after);
    expect(next).toBeGreaterThan(after);
    const d = new Date(next);
    expect(d.getHours()).toBe(9);
    expect(d.getMinutes()).toBe(0);
    // 09:00 today is still ahead of 08:00 → same calendar day.
    expect(d.getDate()).toBe(30);
  });

  it("rolls to tomorrow when the slot already passed", () => {
    const after = new Date(2026, 4, 30, 10, 0, 0).getTime(); // local 10:00
    const next = computeNextRun({ kind: "daily", time: "09:00" }, after);
    const d = new Date(next);
    expect(d.getHours()).toBe(9);
    expect(d.getDate()).toBe(31); // next day
  });

  it("rolls to tomorrow when the slot is exactly now (strictly after)", () => {
    const after = new Date(2026, 4, 30, 9, 0, 0).getTime(); // exactly 09:00
    const next = computeNextRun({ kind: "daily", time: "09:00" }, after);
    expect(next).toBeGreaterThan(after);
    expect(new Date(next).getDate()).toBe(31);
  });
});

describe("describeSchedule", () => {
  it("renders human-friendly summaries", () => {
    expect(describeSchedule({ kind: "interval", everyMs: 30 * 60_000 } as CronSchedule)).toBe("every 30m");
    expect(describeSchedule({ kind: "interval", everyMs: 2 * 3_600_000 } as CronSchedule)).toBe("every 2h");
    expect(describeSchedule({ kind: "interval", everyMs: 86_400_000 } as CronSchedule)).toBe("every 1d");
    expect(describeSchedule({ kind: "daily", time: "09:00" })).toBe("daily at 09:00");
  });
});
