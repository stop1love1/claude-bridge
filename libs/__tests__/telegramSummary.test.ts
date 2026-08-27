import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";


let tempRoot: string;
let originalCwd: string;

beforeEach(() => {
  originalCwd = process.cwd();
  tempRoot = mkdtempSync(join(tmpdir(), "bridge-tg-summary-"));
  process.chdir(tempRoot);
  vi.resetModules();
});

afterEach(() => {
  process.chdir(originalCwd);
  vi.resetModules();
  try {
    rmSync(tempRoot, { recursive: true, force: true });
  } catch {
  }
});

describe("classifyVerdict", () => {
  it("recognizes READY FOR REVIEW (the success verdict)", async () => {
    const { classifyVerdict } = await import("../telegramNotifier");
    expect(classifyVerdict("READY FOR REVIEW — shipped foo")).toEqual({
      icon: "🎉",
      label: "Ready for review",
    });
  });

  it("recognizes AWAITING DECISION (NEEDS-DECISION escalation)", async () => {
    const { classifyVerdict } = await import("../telegramNotifier");
    expect(classifyVerdict("AWAITING DECISION — 2 open question(s)")).toEqual({
      icon: "❓",
      label: "Awaiting decision",
    });
  });

  it("recognizes BLOCKED (any failure mode)", async () => {
    const { classifyVerdict } = await import("../telegramNotifier");
    expect(classifyVerdict("BLOCKED — bridge dispatch unavailable")).toEqual({
      icon: "🔴",
      label: "Blocked",
    });
  });

  it("recognizes PARTIAL (some children failed)", async () => {
    const { classifyVerdict } = await import("../telegramNotifier");
    expect(classifyVerdict("PARTIAL — 1 of 3 children failed")).toEqual({
      icon: "🟠",
      label: "Partial",
    });
  });

  it("falls back to a neutral icon for off-script first lines", async () => {
    const { classifyVerdict } = await import("../telegramNotifier");
    expect(classifyVerdict("# Some Markdown Heading")).toEqual({
      icon: "📌",
      label: "Summary",
    });
  });

  it("is case-insensitive (matches lowercase verdicts the model may emit)", async () => {
    const { classifyVerdict } = await import("../telegramNotifier");
    expect(classifyVerdict("ready for review — shipped").label).toBe(
      "Ready for review",
    );
  });
});

describe("readSummaryMd", () => {
  it("returns null when the file does not exist", async () => {
    const { readSummaryMd } = await import("../telegramNotifier");
    expect(readSummaryMd("t_99990101_001")).toBeNull();
  });

  it("returns null when the file exists but is whitespace-only", async () => {
    const taskId = "t_99990101_002";
    const dir = join(tempRoot, "sessions", taskId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "summary.md"), "\n\n  \t\n", "utf8");
    const { readSummaryMd } = await import("../telegramNotifier");
    expect(readSummaryMd(taskId)).toBeNull();
  });

  it("returns trimmed content when the file has real text", async () => {
    const taskId = "t_99990101_003";
    const dir = join(tempRoot, "sessions", taskId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "summary.md"),
      "  READY FOR REVIEW — shipped foo\n",
      "utf8",
    );
    const { readSummaryMd } = await import("../telegramNotifier");
    expect(readSummaryMd(taskId)).toBe("READY FOR REVIEW — shipped foo");
  });
});

describe("renderCoordinatorSummaryMessage", () => {
  it("renders a READY FOR REVIEW message with verdict header + escaped body", async () => {
    const { renderCoordinatorSummaryMessage } = await import("../telegramNotifier");
    const out = renderCoordinatorSummaryMessage({
      taskId: "t_20260514_001",
      summary: "READY FOR REVIEW — shipped checkout flow.\n\nDetails follow.",
      status: "done",
    });
    expect(out).toContain("🎉");
    expect(out).toContain("Ready for review");
    expect(out).toMatch(/`t\\_20260514\\_001`/);
    expect(out).toContain("shipped checkout flow\\.");
  });

  it("uses ⚠️ + 'Coordinator failed' header when status=failed", async () => {
    const { renderCoordinatorSummaryMessage } = await import("../telegramNotifier");
    const out = renderCoordinatorSummaryMessage({
      taskId: "t_20260514_002",
      summary: "READY FOR REVIEW — shipped",
      status: "failed",
    });
    expect(out).toContain("⚠️");
    expect(out).toContain("Coordinator failed");
  });

  it("truncates a very large summary body but keeps the trailing newline marker", async () => {
    const { renderCoordinatorSummaryMessage } = await import("../telegramNotifier");
    const huge = "X".repeat(10_000);
    const out = renderCoordinatorSummaryMessage({
      taskId: "t_20260514_003",
      summary: `READY FOR REVIEW\n\n${huge}`,
      status: "done",
    });
    expect(out).toContain("…");
    expect(out.length).toBeLessThan(5_000);
  });
});
