import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";


let tempHome: string;

beforeEach(() => {
  tempHome = mkdtempSync(join(tmpdir(), "bridge-tg-pattern-"));
  process.env.HOME = tempHome;
  process.env.USERPROFILE = tempHome;
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  vi.spyOn(require("node:os"), "homedir").mockReturnValue(tempHome);
  vi.resetModules();
});

afterEach(() => {
  vi.restoreAllMocks();
  try {
    rmSync(tempHome, { recursive: true, force: true });
  } catch {
  }
});

function writeManifest(payload: object): void {
  const dir = join(tempHome, ".claude");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "bridge.json"), JSON.stringify(payload), "utf8");
}

describe("forwardChatImportantPatterns getter normalization", () => {
  it("returns the default tokens when the manifest doesn't carry the field", async () => {
    writeManifest({ telegram: { botToken: "t", chatId: "c" } });
    const { getManifestTelegramSettings } = await import("../apps");
    const s = getManifestTelegramSettings();
    expect(s.forwardChatImportantPatterns).toEqual([
      "NEEDS-DECISION",
      "BLOCKED",
      "READY FOR REVIEW",
    ]);
  });

  it("trims and dedupes operator-supplied tokens", async () => {
    writeManifest({
      telegram: {
        botToken: "t",
        chatId: "c",
        forwardChatImportantPatterns: [
          "  NEEDS-DECISION  ",
          "needs-decision",
          "ESCALATE",
          "",
          "ESCALATE",
        ],
      },
    });
    const { getManifestTelegramSettings } = await import("../apps");
    const s = getManifestTelegramSettings();
    expect(s.forwardChatImportantPatterns).toEqual(["NEEDS-DECISION", "ESCALATE"]);
  });

  it("falls back to defaults when the array exists but normalizes empty", async () => {
    writeManifest({
      telegram: {
        botToken: "t",
        chatId: "c",
        forwardChatImportantPatterns: ["", "  ", null, 42],
      },
    });
    const { getManifestTelegramSettings } = await import("../apps");
    const s = getManifestTelegramSettings();
    expect(s.forwardChatImportantPatterns).toEqual([
      "NEEDS-DECISION",
      "BLOCKED",
      "READY FOR REVIEW",
    ]);
  });

  it("caps individual entries at 200 chars and the list at 32 entries", async () => {
    const huge = "x".repeat(500);
    const many = Array.from({ length: 50 }, (_, i) => `tok-${i}`);
    writeManifest({
      telegram: {
        botToken: "t",
        chatId: "c",
        forwardChatImportantPatterns: [huge, ...many],
      },
    });
    const { getManifestTelegramSettings } = await import("../apps");
    const s = getManifestTelegramSettings();
    expect(s.forwardChatImportantPatterns.length).toBe(32);
    expect(s.forwardChatImportantPatterns[0].length).toBe(200);
  });

  it("treats a non-array value as missing (use defaults)", async () => {
    writeManifest({
      telegram: {
        botToken: "t",
        chatId: "c",
        forwardChatImportantPatterns: "not-an-array",
      },
    });
    const { getManifestTelegramSettings } = await import("../apps");
    const s = getManifestTelegramSettings();
    expect(s.forwardChatImportantPatterns).toEqual([
      "NEEDS-DECISION",
      "BLOCKED",
      "READY FOR REVIEW",
    ]);
  });
});

describe("forwardChatImportantPatterns persistence", () => {
  it("setManifestTelegramSettings round-trips a custom token list", async () => {
    writeManifest({});
    const { setManifestTelegramSettings, getManifestTelegramSettings } = await import("../apps");
    setManifestTelegramSettings({
      botToken: "t",
      chatId: "c",
      forwardChatImportantPatterns: ["URGENT", "CRITICAL"],
    });
    const s = getManifestTelegramSettings();
    expect(s.forwardChatImportantPatterns).toEqual(["URGENT", "CRITICAL"]);
  });

  it("does NOT persist the field when the operator's value matches the default list", async () => {
    writeManifest({});
    const { setManifestTelegramSettings } = await import("../apps");
    setManifestTelegramSettings({
      botToken: "t",
      chatId: "c",
      forwardChatImportantPatterns: ["NEEDS-DECISION", "BLOCKED", "READY FOR REVIEW"],
    });
    const fs = await import("node:fs");
    const raw = JSON.parse(
      fs.readFileSync(join(tempHome, ".claude", "bridge.json"), "utf8"),
    ) as { telegram?: { forwardChatImportantPatterns?: unknown } };
    expect(raw.telegram?.forwardChatImportantPatterns).toBeUndefined();
  });
});
