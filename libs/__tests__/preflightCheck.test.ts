import { describe, it, expect } from "vitest";
import { countReadsBeforeEdit, renderPreflightRetryContextBlock, type PreflightResult } from "../preflightCheck";

function jsonl(toolNames: string[]): string {
  return toolNames
    .map((name) =>
      JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "tool_use", name, input: {} }] },
      }),
    )
    .join("\n");
}

function jsonlWithInput(blocks: Array<{ name: string; input?: Record<string, unknown> }>): string {
  return blocks
    .map(({ name, input }) =>
      JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "tool_use", name, input: input ?? {} }] },
      }),
    )
    .join("\n");
}

describe("countReadsBeforeEdit", () => {
  it("counts Read/Grep/Glob/LS calls before the first Edit", () => {
    const text = jsonl(["Read", "Grep", "Read", "Edit", "Read", "Write"]);
    const got = countReadsBeforeEdit(text);
    expect(got.readsBeforeEdit).toBe(3);
    expect(got.editCount).toBe(2);
  });

  it("returns 0 readsBeforeEdit when Edit is the first tool call", () => {
    const text = jsonl(["Edit", "Read", "Read"]);
    const got = countReadsBeforeEdit(text);
    expect(got.readsBeforeEdit).toBe(0);
    expect(got.editCount).toBe(1);
  });

  it("returns editCount=0 for a read-only session", () => {
    const text = jsonl(["Read", "Grep", "Glob", "LS", "Read"]);
    const got = countReadsBeforeEdit(text);
    expect(got.readsBeforeEdit).toBe(5);
    expect(got.editCount).toBe(0);
  });

  it("treats MultiEdit and NotebookEdit as Edit calls", () => {
    expect(countReadsBeforeEdit(jsonl(["Read", "MultiEdit"])).editCount).toBe(1);
    expect(countReadsBeforeEdit(jsonl(["Read", "NotebookEdit"])).editCount).toBe(1);
  });

  it("ignores Bash and other non-Read non-Edit tool calls", () => {
    const text = jsonl(["Bash", "Bash", "Edit"]);
    const got = countReadsBeforeEdit(text);
    expect(got.readsBeforeEdit).toBe(0);
    expect(got.editCount).toBe(1);
  });

  it("survives malformed lines / empty lines", () => {
    const text = ["", "not json", jsonl(["Read", "Edit"]), ""].join("\n");
    const got = countReadsBeforeEdit(text);
    expect(got.editCount).toBe(1);
    expect(got.readsBeforeEdit).toBe(1);
  });

  it("ignores user/system messages and counts only assistant tool_use blocks", () => {
    const text = [
      JSON.stringify({ type: "user", message: { content: "do the thing" } }),
      JSON.stringify({ type: "system", message: { content: "init" } }),
      JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "text", text: "let me read first" }, { type: "tool_use", name: "Read" }] },
      }),
      JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "tool_use", name: "Edit" }] },
      }),
    ].join("\n");
    const got = countReadsBeforeEdit(text);
    expect(got.readsBeforeEdit).toBe(1);
    expect(got.editCount).toBe(1);
  });

  it("counts distinct files, not tool calls", () => {
    const text = jsonlWithInput([
      { name: "Read", input: { file_path: "/a.ts" } },
      { name: "Read", input: { file_path: "/a.ts" } },
      { name: "Read", input: { file_path: "/a.ts" } },
      { name: "Edit", input: { file_path: "/a.ts" } },
    ]);
    expect(countReadsBeforeEdit(text).readsBeforeEdit).toBe(1);
  });

  it("counts each distinct file path once even when interleaved", () => {
    const text = jsonlWithInput([
      { name: "Read", input: { file_path: "/a.ts" } },
      { name: "Read", input: { file_path: "/b.ts" } },
      { name: "Read", input: { file_path: "/a.ts" } },
      { name: "Edit", input: { file_path: "/a.ts" } },
    ]);
    expect(countReadsBeforeEdit(text).readsBeforeEdit).toBe(2);
  });

  it("de-duplicates Grep/Glob by pattern rather than tool-call count", () => {
    const text = jsonlWithInput([
      { name: "Grep", input: { pattern: "foo" } },
      { name: "Grep", input: { pattern: "foo" } },
      { name: "Glob", input: { pattern: "**/*.ts" } },
      { name: "Edit", input: { file_path: "/a.ts" } },
    ]);
    expect(countReadsBeforeEdit(text).readsBeforeEdit).toBe(2);
  });

  it("counts Read file_path and Grep pattern as separate signals", () => {
    const text = jsonlWithInput([
      { name: "Read", input: { file_path: "/a.ts" } },
      { name: "Grep", input: { pattern: "foo" } },
      { name: "Glob", input: { pattern: "**/*.ts" } },
      { name: "Edit", input: { file_path: "/a.ts" } },
    ]);
    expect(countReadsBeforeEdit(text).readsBeforeEdit).toBe(3);
  });

  it("still counts calls with no identifiable path/pattern as distinct (unchanged legacy behaviour)", () => {
    const text = jsonl(["Read", "Grep", "Read", "Edit", "Read", "Write"]);
    expect(countReadsBeforeEdit(text).readsBeforeEdit).toBe(3);
  });

  it.runIf(process.platform === "win32")(
    "normalises case only on Windows, so differently-cased paths to the same file dedupe",
    () => {
      const text = jsonlWithInput([
        { name: "Read", input: { file_path: "C:\\Repo\\a.ts" } },
        { name: "Read", input: { file_path: "c:\\repo\\A.TS" } },
        { name: "Edit", input: { file_path: "C:\\Repo\\a.ts" } },
      ]);
      expect(countReadsBeforeEdit(text).readsBeforeEdit).toBe(1);
    },
  );

  it.runIf(process.platform !== "win32")(
    "treats differently-cased paths as distinct off Windows",
    () => {
      const text = jsonlWithInput([
        { name: "Read", input: { file_path: "/repo/a.ts" } },
        { name: "Read", input: { file_path: "/repo/A.TS" } },
        { name: "Edit", input: { file_path: "/repo/a.ts" } },
      ]);
      expect(countReadsBeforeEdit(text).readsBeforeEdit).toBe(2);
    },
  );
});

describe("renderPreflightRetryContextBlock", () => {
  it("includes the verdict heading and the read counts", () => {
    const result: PreflightResult = {
      verdict: "fail",
      reason: "agent made 1 Read call(s) before the first Edit/Write — minimum is 3",
      readsBeforeEdit: 1,
      editCount: 4,
      required: 3,
    };
    const out = renderPreflightRetryContextBlock(result);
    expect(out).toContain("## Auto-retry context — what failed last time");
    expect(out).toContain("PREFLIGHT FAIL");
    expect(out).toContain("Read calls before first Edit/Write: **1**");
    expect(out).toContain("required: **3**");
    expect(out).toContain("Edit/Write calls total: 4");
  });

  it("instructs the agent on the required process", () => {
    const result: PreflightResult = {
      verdict: "fail",
      reason: "x",
      readsBeforeEdit: 0,
      editCount: 5,
      required: 3,
    };
    const out = renderPreflightRetryContextBlock(result);
    expect(out).toContain("**Grep / Read at least 3 relevant files**");
  });
});
