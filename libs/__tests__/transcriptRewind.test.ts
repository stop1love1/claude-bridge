import { describe, expect, it } from "vitest";
import { truncateTranscript } from "../transcriptRewind";

function line(uuid: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ uuid, ...extra });
}

const CONTENT = [line("a"), line("b"), line("c"), line("d")].join("\n") + "\n";

describe("truncateTranscript", () => {
  it("keeps the target entry by default, so rewind lands on it", () => {
    const r = truncateTranscript(CONTENT, "b");
    expect(r).not.toBeNull();
    expect(r!.kept).toBe(2);
    expect(r!.dropped).toBe(2);
    expect(r!.payload).toBe([line("a"), line("b")].join("\n") + "\n");
  });

  it("drops the target entry when inclusive is false, so an edit can replace it", () => {
    const r = truncateTranscript(CONTENT, "b", { inclusive: false });
    expect(r!.kept).toBe(1);
    expect(r!.dropped).toBe(3);
    expect(r!.payload).toBe(line("a") + "\n");
  });

  it("returns an empty payload when the first entry is dropped", () => {
    const r = truncateTranscript(CONTENT, "a", { inclusive: false });
    expect(r!.kept).toBe(0);
    expect(r!.payload).toBe("");
  });

  it("returns null when the uuid is absent", () => {
    expect(truncateTranscript(CONTENT, "zzz")).toBeNull();
  });

  it("scans past blank and unparseable lines, and keeps the unparseable ones", () => {
    const messy = [line("a"), "", "not json", line("b"), line("c")].join("\n");
    const r = truncateTranscript(messy, "b");
    // a + "not json" + b — a half-written line is data we must not silently drop.
    expect(r!.kept).toBe(3);
    expect(r!.payload).toContain("not json");
    expect(r!.payload.endsWith("\n")).toBe(true);
  });

  it("always terminates the payload with a newline when non-empty", () => {
    const noTrailing = [line("a"), line("b")].join("\n");
    expect(truncateTranscript(noTrailing, "b")!.payload).toBe(noTrailing + "\n");
  });

  it("counts dropped entries without counting the trailing blank line", () => {
    const r = truncateTranscript(CONTENT, "c");
    expect(r!.dropped).toBe(1);
  });
});
