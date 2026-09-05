import { describe, expect, it } from "vitest";
import { untilTime } from "../client/time";

const NOW = Date.parse("2026-09-05T02:00:00.000Z");

describe("untilTime", () => {
  it("describes a future instant relative to now", () => {
    expect(untilTime(new Date(NOW + 30_000).toISOString(), NOW)).toBe("in 30s");
    expect(untilTime(new Date(NOW + 5 * 60_000).toISOString(), NOW)).toBe("in 5m");
    expect(untilTime(new Date(NOW + 3 * 3_600_000).toISOString(), NOW)).toBe("in 3h");
    expect(untilTime(new Date(NOW + 2 * 86_400_000).toISOString(), NOW)).toBe("in 2d");
  });
  it("says 'due' once the instant has passed", () => {
    expect(untilTime(new Date(NOW - 1_000).toISOString(), NOW)).toBe("due");
  });
  it("is defensive about bad input", () => {
    expect(untilTime(null, NOW)).toBe("—");
    expect(untilTime("garbage", NOW)).toBe("garbage");
  });
});
