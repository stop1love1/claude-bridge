import { describe, expect, it } from "vitest";
import {
  asBlocks,
  classify,
  extractAttachments,
  extractImagePaths,
  HIDDEN_TYPES,
  prettyToolName,
  stringifyResult,
  stripSystemTags,
  summarizeInput,
  type LogEntry,
} from "../../app/_components/SessionLog/helpers";

describe("classify", () => {
  it("flags every HIDDEN_TYPES entry as hidden", () => {
    for (const t of HIDDEN_TYPES) {
      expect(classify({ type: t })).toBe("hidden");
    }
  });

  it("returns user for plain user messages", () => {
    expect(classify({ type: "user", message: { role: "user", content: "hi" } })).toBe("user");
  });

  it("returns tool_result for user messages whose content has a tool_result block", () => {
    const e: LogEntry = {
      type: "user",
      message: {
        role: "user",
        content: [{ type: "tool_result", content: "ok" }],
      },
    };
    expect(classify(e)).toBe("tool_result");
  });

  it("returns assistant for assistant messages", () => {
    expect(classify({ type: "assistant" })).toBe("assistant");
  });

  it("falls back to hidden for unknown types", () => {
    expect(classify({ type: "garbage" })).toBe("hidden");
    expect(classify({})).toBe("hidden");
  });
});

describe("asBlocks", () => {
  it("wraps a string into a single text block", () => {
    expect(asBlocks("hello")).toEqual([{ type: "text", text: "hello" }]);
  });

  it("returns an array unchanged", () => {
    const a = [{ type: "text", text: "x" }];
    expect(asBlocks(a)).toBe(a);
  });

  it("returns an empty array for null / object / number inputs", () => {
    expect(asBlocks(null)).toEqual([]);
    expect(asBlocks({})).toEqual([]);
    expect(asBlocks(42)).toEqual([]);
  });
});

describe("stripSystemTags", () => {
  it("removes a single tagged section", () => {
    const out = stripSystemTags(
      "before <system-reminder>noise</system-reminder> after",
    );
    expect(out).toBe("before  after");
  });

  it("removes nested tagged sections in a few iterations", () => {
    const text =
      "<command-message>cmd</command-message><ide_opened_file>foo.ts</ide_opened_file>visible";
    expect(stripSystemTags(text)).toBe("visible");
  });

  it("collapses 3+ blank lines left after stripping a tag", () => {
    // The function only runs the newline-collapse pass when a `<` is
    // present (fast-path otherwise), so we anchor the test on a real
    // strippable tag and verify the collapse cleans up afterwards.
    const text = "a\n<system-reminder>x</system-reminder>\n\n\n\nb";
    expect(stripSystemTags(text)).toBe("a\n\nb");
  });

  it("leaves arbitrary <foo> tags the user actually typed alone", () => {
    expect(stripSystemTags("see <foo> and </foo> below")).toBe(
      "see <foo> and </foo> below",
    );
  });

  it("returns input untouched when there's no `<` at all (fast path)", () => {
    expect(stripSystemTags("just plain text")).toBe("just plain text");
  });

  it("handles empty input", () => {
    expect(stripSystemTags("")).toBe("");
  });
});

describe("summarizeInput", () => {
  it("prefers file_path → path → command → pattern → url → query → description", () => {
    expect(summarizeInput({ file_path: "a.ts", path: "b.ts" })).toBe("a.ts");
    expect(summarizeInput({ path: "b.ts", command: "ls" })).toBe("b.ts");
    expect(summarizeInput({ command: "ls -la" })).toBe("ls -la");
    expect(summarizeInput({ pattern: "**/*.tsx" })).toBe("**/*.tsx");
    expect(summarizeInput({ url: "https://x" })).toBe("https://x");
    expect(summarizeInput({ query: "tail -f" })).toBe("tail -f");
    expect(summarizeInput({ description: "scan repo" })).toBe("scan repo");
  });

  it("truncates very long primaries with an ellipsis", () => {
    const long = "x".repeat(120);
    const out = summarizeInput({ command: long });
    expect(out.length).toBeLessThanOrEqual(91);
    expect(out.endsWith("…")).toBe(true);
  });

  it("returns empty for null / non-object / no-match", () => {
    expect(summarizeInput(null)).toBe("");
    expect(summarizeInput("nope")).toBe("");
    expect(summarizeInput({ unrelated: "x" })).toBe("");
  });
});

describe("stringifyResult", () => {
  it("returns strings unchanged", () => {
    expect(stringifyResult("hello")).toBe("hello");
  });

  it("joins array of {text} blocks with newlines", () => {
    expect(
      stringifyResult([{ text: "line1" }, { text: "line2" }]),
    ).toBe("line1\nline2");
  });

  it("falls back to JSON for non-text array entries", () => {
    expect(stringifyResult([{ foo: 1 }])).toBe('{"foo":1}');
  });

  it("pretty-prints non-string non-array content as JSON", () => {
    expect(stringifyResult({ a: 1 })).toBe(JSON.stringify({ a: 1 }, null, 2));
  });
});

describe("prettyToolName", () => {
  it("passes built-in tools through unchanged", () => {
    expect(prettyToolName("Bash")).toBe("Bash");
    expect(prettyToolName("Read")).toBe("Read");
  });

  it("strips the mcp__plugin_ prefix and pretties the rest", () => {
    expect(
      prettyToolName("mcp__plugin_playwright_playwright__browser_navigate"),
    ).toBe("playwright · browser navigate");
  });

  it("collapses repeated head segments (playwright_playwright → playwright)", () => {
    expect(
      prettyToolName("mcp__plugin_context7_context7__search_docs"),
    ).toBe("context7 · search docs");
  });

  it("returns the raw input on empty/no-match", () => {
    expect(prettyToolName("")).toBe("");
  });
});

describe("extractImagePaths", () => {
  it("picks up markdown image links", () => {
    expect(
      extractImagePaths("see ![alt](shots/before.png) for context"),
    ).toEqual(["shots/before.png"]);
  });

  it("picks up bare-path lines with image extensions", () => {
    expect(
      extractImagePaths("logs:\nshots/after.PNG\nend"),
    ).toEqual(["shots/after.PNG"]);
  });

  it("skips http/https URLs", () => {
    expect(
      extractImagePaths("![a](https://example.com/img.png)"),
    ).toEqual([]);
  });

  it("dedupes when both forms reference the same file", () => {
    const out = extractImagePaths(
      "![a](shots/x.png)\nshots/x.png\n",
    );
    expect(out).toEqual(["shots/x.png"]);
  });
});

describe("extractAttachments", () => {
  it("pulls one attachment + cleans the body", () => {
    const text =
      "hello, see this:\nAttached file: `D:/x/photo.png` (photo.png, 1234 bytes) — local screenshot\n";
    const { stripped, items } = extractAttachments(text);
    expect(stripped).toBe("hello, see this:");
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      rawPath: "D:/x/photo.png",
      name: "photo.png",
      size: 1234,
      isImage: true,
    });
  });

  it("keeps non-attachment lines verbatim", () => {
    const text = "plain user message\nwith multiple lines\n";
    const { stripped, items } = extractAttachments(text);
    expect(stripped).toBe("plain user message\nwith multiple lines");
    expect(items).toEqual([]);
  });

  it("flags non-image extensions as isImage=false", () => {
    const text = "Attached file: `notes.pdf` (notes.pdf, 4096 bytes)";
    const { items } = extractAttachments(text);
    expect(items[0].isImage).toBe(false);
  });

  it("handles missing meta-parens", () => {
    const text = "Attached file: `D:/raw/path`";
    const { items } = extractAttachments(text);
    expect(items[0]).toMatchObject({ rawPath: "D:/raw/path", name: "path" });
    expect(items[0].size).toBeUndefined();
  });

  it("trims leading/trailing blank lines left after the strip", () => {
    const text = "\n\nAttached file: `x.png` (x.png, 1 bytes)\n\n";
    const { stripped, items } = extractAttachments(text);
    expect(stripped).toBe("");
    expect(items).toHaveLength(1);
  });
});
