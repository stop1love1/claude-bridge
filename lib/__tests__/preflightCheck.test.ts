import { describe, it, expect } from "vitest";
import { countReadsBeforeEdit, renderPreflightRetryContextBlock, type PreflightResult } from "../preflightCheck";

/**
 * Build a synthetic .jsonl session: one assistant message per line,
 * each containing one tool_use block with the given tool name. This
 * is the smallest shape the parser cares about.
 */
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
    expect(got.readsBeforeEdit).toBe(0); // Bash isn't a Read tool
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
    // Renderer wraps the whole phrase (not just the number) in bold.
    expect(out).toContain("**Grep / Read at least 3 relevant files**");
  });
});
