import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

/**
 * The lifecycle notifier sends ONE consolidated Telegram message on
 * coordinator completion — composed from `summary.md` instead of the
 * legacy "✅ coordinator completed" stub. These tests pin the verdict
 * classifier, the file reader, and the rendered MarkdownV2 message
 * shape so a refactor can't silently regress operator-visible output.
 *
 * The two FS-touching helpers (`readSummaryMd`) resolve their path via
 * `SESSIONS_DIR`, which is captured at module load from
 * `process.cwd()`. We chdir → resetModules → import so each test sees
 * the temp dir as its bridge root. Same trick the
 * `forwardChatImportantPatterns` tests use for `homedir()`.
 */

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
    /* best-effort */
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
    // Header has the verdict icon + escaped label + escaped taskId
    expect(out).toContain("🎉");
    expect(out).toContain("Ready for review");
    // MarkdownV2 escapes the `_` in the task id
    expect(out).toMatch(/`t\\_20260514\\_001`/);
    // Body is MarkdownV2-escaped (the literal `.` after "flow" must be
    // backslash-escaped so Telegram doesn't try to parse it).
    expect(out).toContain("shipped checkout flow\\.");
  });

  it("uses ⚠️ + 'Coordinator failed' header when status=failed", async () => {
    const { renderCoordinatorSummaryMessage } = await import("../telegramNotifier");
    const out = renderCoordinatorSummaryMessage({
      taskId: "t_20260514_002",
      // Body could be anything — verdict classifier is overridden by
      // the failed-status branch.
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
    // Truncation marker present
    expect(out).toContain("…");
    // Stays under Telegram's MAX_TEXT (3500 + small overhead is fine,
    // but the source caps the body so this is a safety check).
    expect(out.length).toBeLessThan(5_000);
  });
});
