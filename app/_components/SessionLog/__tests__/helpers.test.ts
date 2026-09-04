import { describe, it, expect } from "vitest";
import {
  parseAskUserQuestion,
  buildAnswerMessage,
  classify,
  asBlocks,
  stripSystemTags,
  summarizeInput,
  stringifyResult,
  extractResultImages,
  prettyToolName,
  extractImagePaths,
  extractAttachments,
  formatEntryTime,
  entryPlainText,
  pruneOptimistic,
  type LogEntry,
  type AskUserQuestion,
} from "../helpers";

describe("parseAskUserQuestion", () => {
  it("returns null for non-objects and missing/!array questions", () => {
    expect(parseAskUserQuestion(null)).toBeNull();
    expect(parseAskUserQuestion("x")).toBeNull();
    expect(parseAskUserQuestion({})).toBeNull();
    expect(parseAskUserQuestion({ questions: "nope" })).toBeNull();
  });

  it("returns null when the questions array yields nothing usable", () => {
    expect(parseAskUserQuestion({ questions: [] })).toBeNull();
    expect(parseAskUserQuestion({ questions: [null, "x", 3] })).toBeNull();
  });

  it("parses a well-formed question with options", () => {
    const out = parseAskUserQuestion({
      questions: [
        {
          question: "Pick one",
          header: "Choice",
          multiSelect: true,
          options: [
            { label: "A", description: "first" },
            { label: "B" },
          ],
        },
      ],
    });
    expect(out).toEqual([
      {
        question: "Pick one",
        header: "Choice",
        multiSelect: true,
        options: [
          { label: "A", description: "first" },
          { label: "B", description: undefined },
        ],
      },
    ]);
  });

  it("drops options with an empty/missing label and defaults fields", () => {
    const out = parseAskUserQuestion({
      questions: [
        { options: [{ description: "x" }, { label: "" }, { label: "Keep" }] },
      ],
    });
    expect(out).toEqual([
      {
        question: "",
        header: "",
        multiSelect: false,
        options: [{ label: "Keep", description: undefined }],
      },
    ]);
  });

  it("coerces multiSelect to a strict boolean", () => {
    const out = parseAskUserQuestion({
      questions: [{ question: "q", multiSelect: "true", options: [{ label: "A" }] }],
    });
    expect(out?.[0].multiSelect).toBe(false);
  });
});

describe("buildAnswerMessage", () => {
  const q = (header: string, question: string): AskUserQuestion => ({
    header,
    question,
    multiSelect: false,
    options: [],
  });

  it("labels each answered question and joins picks", () => {
    const out = buildAnswerMessage(
      [q("H1", "Q1"), q("", "Q2")],
      [["a", " b "], ["c"]],
    );
    expect(out).toBe("H1: a, b\nQ2: c");
  });

  it("omits questions with no (non-empty) selections", () => {
    const out = buildAnswerMessage([q("H1", "Q1"), q("H2", "Q2")], [[], ["  "]]);
    expect(out).toBe("");
  });

  it("falls back to a positional label when header and question are blank", () => {
    const out = buildAnswerMessage([q("", "")], [["x"]]);
    expect(out).toBe("Question 1: x");
  });
});

describe("classify", () => {
  it("marks hidden types as hidden", () => {
    expect(classify({ type: "summary" })).toBe("hidden");
    expect(classify({ type: "ai-title" })).toBe("hidden");
  });

  it("treats a user turn carrying a tool_result as tool_result", () => {
    expect(
      classify({ type: "user", message: { content: [{ type: "tool_result" }] } }),
    ).toBe("tool_result");
  });

  it("classifies plain user and assistant turns", () => {
    expect(classify({ type: "user", message: { content: "hi" } })).toBe("user");
    expect(classify({ type: "assistant", message: { content: "yo" } })).toBe(
      "assistant",
    );
  });

  it("classifies unknown/absent types as hidden", () => {
    expect(classify({ type: "mystery" })).toBe("hidden");
    expect(classify({})).toBe("hidden");
  });
});

describe("asBlocks", () => {
  it("wraps a string as a single text block", () => {
    expect(asBlocks("hello")).toEqual([{ type: "text", text: "hello" }]);
  });

  it("passes an array through unchanged", () => {
    const blocks = [{ type: "text", text: "a" }];
    expect(asBlocks(blocks)).toBe(blocks);
  });

  it("returns [] for anything else", () => {
    expect(asBlocks(null)).toEqual([]);
    expect(asBlocks(42)).toEqual([]);
    expect(asBlocks({ nope: true })).toEqual([]);
  });
});

describe("stripSystemTags", () => {
  it("returns text unchanged when there is no '<'", () => {
    expect(stripSystemTags("plain text")).toBe("plain text");
  });

  it("removes a paired system tag and its contents", () => {
    expect(stripSystemTags("a<system-reminder>secret</system-reminder>b")).toBe(
      "ab",
    );
  });

  it("removes stray open/close system tags", () => {
    expect(stripSystemTags("x<command-name>y")).toBe("xy");
  });

  it("leaves non-system tags intact", () => {
    expect(stripSystemTags("<b>hi</b>")).toBe("<b>hi</b>");
  });
});

describe("summarizeInput", () => {
  it("returns '' for non-objects", () => {
    expect(summarizeInput(null)).toBe("");
    expect(summarizeInput("x")).toBe("");
  });

  it("prefers file_path/path over command in that order", () => {
    expect(summarizeInput({ file_path: "/a/b.txt", command: "ls" })).toBe(
      "/a/b.txt",
    );
    expect(summarizeInput({ path: "P", command: "C" })).toBe("P");
    expect(summarizeInput({ command: "ls -la" })).toBe("ls -la");
  });

  it("truncates long values to 90 chars + ellipsis", () => {
    const out = summarizeInput({ query: "y".repeat(100) });
    expect(out.length).toBe(91);
    expect(out.endsWith("…")).toBe(true);
  });

  it("returns '' when the primary field is not a string", () => {
    expect(summarizeInput({ file_path: 123 })).toBe("");
  });
});

describe("stringifyResult", () => {
  it("returns a string result verbatim", () => {
    expect(stringifyResult("done")).toBe("done");
  });

  it("joins string/text blocks and drops image blocks", () => {
    const out = stringifyResult([
      "a",
      { text: "b" },
      { type: "image", source: { type: "base64", data: "AAA" } },
      { n: 1 },
    ]);
    expect(out).toBe('a\nb\n{"n":1}');
  });

  it("pretty-prints a non-array object", () => {
    expect(stringifyResult({ a: 1 })).toBe(JSON.stringify({ a: 1 }, null, 2));
  });

  it("truncates an oversized block", () => {
    const out = stringifyResult([{ big: "x".repeat(3000) }]);
    expect(out).toContain("… (truncated");
    expect(out.startsWith('{"big":"xxx')).toBe(true);
  });
});

describe("extractResultImages", () => {
  it("returns [] for non-arrays", () => {
    expect(extractResultImages("x")).toEqual([]);
  });

  it("extracts base64 images with a default media type", () => {
    const out = extractResultImages([
      { type: "image", source: { type: "base64", media_type: "image/jpeg", data: "AAA" } },
      { type: "image", source: { type: "base64", data: "BBB" } },
    ]);
    expect(out).toEqual([
      { mediaType: "image/jpeg", data: "AAA" },
      { mediaType: "image/png", data: "BBB" },
    ]);
  });

  it("skips non-base64 sources, empty data, and non-image blocks", () => {
    const out = extractResultImages([
      { type: "image", source: { type: "url", url: "http://x" } },
      { type: "image", source: { type: "base64", data: "" } },
      { type: "text", text: "hi" },
    ]);
    expect(out).toEqual([]);
  });
});

describe("prettyToolName", () => {
  it("returns non-plugin names unchanged", () => {
    expect(prettyToolName("")).toBe("");
    expect(prettyToolName("Bash")).toBe("Bash");
  });

  it("de-duplicates the plugin head and prettifies the tail", () => {
    expect(
      prettyToolName("mcp__plugin_playwright_playwright__browser_take_screenshot"),
    ).toBe("playwright · browser take screenshot");
  });

  it("keeps distinct head parts and formats the tool tail", () => {
    expect(prettyToolName("mcp__plugin_foo_bar__do_thing")).toBe(
      "foo bar · do thing",
    );
  });

  it("handles a plugin name with no tool separator", () => {
    expect(prettyToolName("mcp__plugin_context7")).toBe("context7");
  });
});

describe("extractImagePaths", () => {
  it("pulls markdown and bare-line image paths and drops URLs", () => {
    const text = "See ![a](assets/one.png) and\ntwo.jpeg\nhttp://x/three.gif";
    expect(extractImagePaths(text)).toEqual(["assets/one.png", "two.jpeg"]);
  });

  it("de-duplicates repeated paths", () => {
    const text = "![a](p.png)\np.png";
    expect(extractImagePaths(text)).toEqual(["p.png"]);
  });
});

describe("extractAttachments", () => {
  it("pulls an attachment line into a parsed item and keeps the prose", () => {
    const { stripped, items } = extractAttachments(
      "Hello\nAttached file: `/imgs/a.png` (a.png, 1234 bytes)\nWorld",
    );
    expect(stripped).toBe("Hello\nWorld");
    expect(items).toEqual([
      { rawPath: "/imgs/a.png", name: "a.png", size: 1234, isImage: true },
    ]);
  });

  it("falls back to the basename and flags non-images when no meta", () => {
    const { stripped, items } = extractAttachments("Attached file: `/x/y.pdf`");
    expect(stripped).toBe("");
    expect(items).toEqual([
      { rawPath: "/x/y.pdf", name: "y.pdf", size: undefined, isImage: false },
    ]);
  });

  it("trims trailing blank lines left behind after stripping", () => {
    const { stripped } = extractAttachments("text\n\nAttached file: `a.png`");
    expect(stripped).toBe("text");
  });
});

describe("formatEntryTime", () => {
  it("returns '' for empty or unparseable input", () => {
    expect(formatEntryTime(null)).toBe("");
    expect(formatEntryTime(undefined)).toBe("");
    expect(formatEntryTime("")).toBe("");
    expect(formatEntryTime("not-a-date")).toBe("");
  });

  it("returns a non-empty time string for a valid ISO date", () => {
    // Locale/timezone-dependent formatting, so assert shape not exact value.
    const out = formatEntryTime("2026-09-04T12:34:00Z");
    expect(out.length).toBeGreaterThan(0);
    expect(/\d/.test(out)).toBe(true);
  });
});

describe("entryPlainText", () => {
  it("joins text blocks, drops non-text, and strips system tags", () => {
    const entry: LogEntry = {
      message: {
        content: [
          { type: "text", text: "Hello" },
          { type: "thinking", thinking: "hidden" },
          { type: "text", text: "there<system-reminder>x</system-reminder>" },
        ],
      },
    };
    expect(entryPlainText(entry)).toBe("Hello\n\nthere");
  });

  it("handles string content", () => {
    expect(entryPlainText({ message: { content: "just text" } })).toBe(
      "just text",
    );
  });
});

describe("pruneOptimistic", () => {
  const optimistic = (text: string): LogEntry => ({
    uuid: `optimistic:${text}`,
    type: "user",
    message: { content: text },
  });
  const arrivedUser = (text: string): LogEntry => ({
    uuid: `real:${text}`,
    type: "user",
    message: { content: text },
  });

  it("returns prev unchanged when either side is empty", () => {
    const prev = [optimistic("hi")];
    expect(pruneOptimistic(prev, [])).toBe(prev);
    expect(pruneOptimistic([], [arrivedUser("hi")])).toEqual([]);
  });

  it("removes an optimistic placeholder whose text has now arrived", () => {
    const keep: LogEntry = { uuid: "x", type: "assistant", message: { content: "ok" } };
    const prev = [optimistic("hello"), keep];
    const out = pruneOptimistic(prev, [arrivedUser("hello")]);
    expect(out).toEqual([keep]);
  });

  it("keeps the placeholder (same ref) when nothing matches", () => {
    const prev = [optimistic("hello")];
    const out = pruneOptimistic(prev, [arrivedUser("different")]);
    expect(out).toBe(prev);
  });

  it("ignores arrived tool_result turns (not the user's own message)", () => {
    const prev = [optimistic("hello")];
    const toolResult: LogEntry = {
      type: "user",
      message: { content: [{ type: "tool_result", content: "hello" }] },
    };
    expect(pruneOptimistic(prev, [toolResult])).toBe(prev);
  });
});
