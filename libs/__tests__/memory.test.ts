import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendMemory,
  loadMemory,
  memoryFilePath,
  renderMemorySection,
  topMemoryEntries,
  MEMORY_DIR_NAME,
  MEMORY_FILE_NAME,
} from "../memory";

let appPath: string;

beforeEach(() => {
  appPath = mkdtempSync(join(tmpdir(), "bridge-mem-"));
});
afterEach(() => {
  try { rmSync(appPath, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe("memoryFilePath", () => {
  it("places memory under .bridge/memory.md inside the app", () => {
    expect(memoryFilePath("/abs/app")).toBe(
      join("/abs/app", MEMORY_DIR_NAME, MEMORY_FILE_NAME),
    );
  });
});

describe("loadMemory", () => {
  it("returns null when appPath is null or relative", () => {
    expect(loadMemory(null)).toBeNull();
    expect(loadMemory("./relative")).toBeNull();
  });

  it("returns null when the file does not exist", () => {
    expect(loadMemory(appPath)).toBeNull();
  });

  it("reads the file when present and trims trailing whitespace", () => {
    mkdirSync(join(appPath, MEMORY_DIR_NAME), { recursive: true });
    writeFileSync(
      memoryFilePath(appPath),
      "- entry one\n- entry two\n\n",
    );
    expect(loadMemory(appPath)).toBe("- entry one\n- entry two");
  });
});

describe("topMemoryEntries", () => {
  it("returns empty list when memory is missing", () => {
    expect(topMemoryEntries(appPath)).toEqual([]);
  });

  it("returns each non-empty non-header line", () => {
    mkdirSync(join(appPath, MEMORY_DIR_NAME), { recursive: true });
    writeFileSync(
      memoryFilePath(appPath),
      [
        "# header",
        "- first",
        "",
        "- second",
        "- third",
      ].join("\n"),
    );
    expect(topMemoryEntries(appPath)).toEqual(["- first", "- second", "- third"]);
  });

  it("respects the explicit limit", () => {
    mkdirSync(join(appPath, MEMORY_DIR_NAME), { recursive: true });
    writeFileSync(
      memoryFilePath(appPath),
      Array.from({ length: 20 }, (_, i) => `- entry ${i}`).join("\n"),
    );
    expect(topMemoryEntries(appPath, 3)).toEqual([
      "- entry 0",
      "- entry 1",
      "- entry 2",
    ]);
  });
});

describe("appendMemory", () => {
  it("rejects null appPath, non-string entry, empty entry", () => {
    expect(appendMemory(null, "x")).toBeNull();
    // @ts-expect-error testing runtime guard
    expect(appendMemory(appPath, 42)).toBeNull();
    expect(appendMemory(appPath, "   ")).toBeNull();
  });

  it("creates .bridge/memory.md on first append", () => {
    const stored = appendMemory(appPath, "When X → do Y because Z");
    expect(stored).toBe("- When X → do Y because Z");
    const file = memoryFilePath(appPath);
    expect(existsSync(file)).toBe(true);
    expect(readFileSync(file, "utf8")).toBe("- When X → do Y because Z\n");
  });

  it("prepends new entries (newest first)", () => {
    appendMemory(appPath, "first");
    appendMemory(appPath, "second");
    const text = readFileSync(memoryFilePath(appPath), "utf8");
    const lines = text.split("\n").filter(Boolean);
    expect(lines).toEqual(["- second", "- first"]);
  });

  it("flattens leading bullet markers and collapses whitespace", () => {
    expect(appendMemory(appPath, "- already   bulleted")).toBe(
      "- already bulleted",
    );
  });

  it("is idempotent against immediate duplicates", () => {
    appendMemory(appPath, "rule one");
    appendMemory(appPath, "rule one");
    const text = readFileSync(memoryFilePath(appPath), "utf8");
    expect(text.match(/rule one/g)?.length).toBe(1);
  });
});

describe("renderMemorySection", () => {
  it("returns empty string when there are no entries", () => {
    expect(renderMemorySection([])).toBe("");
  });

  it("renders a heading + blurb + bullets", () => {
    const out = renderMemorySection(["- one", "two"]);
    expect(out).toContain("## Memory");
    expect(out).toContain("- one");
    // Plain entry without leading dash gets prefixed.
    expect(out).toContain("- two");
  });
});
