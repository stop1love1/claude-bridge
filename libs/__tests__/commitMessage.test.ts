import { describe, it, expect } from "vitest";
import { buildPrompt, parseLLMResponse } from "../commitMessage";

describe("parseLLMResponse", () => {
  it("accepts a clean Conventional Commits header + body", () => {
    const raw = [
      "feat(retry): add per-task ceiling to retry ladder",
      "",
      "AppRetry.totalCap (default 4) caps total retry attempts across",
      "all gates and chains. Prevents the 5 × 2 × N children blowup.",
    ].join("\n");
    const out = parseLLMResponse(raw);
    expect(out).not.toBeNull();
    expect(out!.split("\n")[0]).toBe(
      "feat(retry): add per-task ceiling to retry ladder",
    );
    expect(out).toContain("AppRetry.totalCap");
  });

  it("accepts a header-only message (no body)", () => {
    const out = parseLLMResponse("fix: handle null in resolveBase");
    expect(out).toBe("fix: handle null in resolveBase");
  });

  it("accepts every valid Conventional Commits type", () => {
    for (const type of ["feat", "fix", "refactor", "docs", "test", "chore", "perf", "style", "build", "ci"]) {
      const out = parseLLMResponse(`${type}: something`);
      expect(out, `${type} should parse`).toBe(`${type}: something`);
    }
  });

  it("rejects an invalid type", () => {
    expect(parseLLMResponse("foo: nope")).toBeNull();
    expect(parseLLMResponse("FEAT: caps")).toBeNull();
  });

  it("strips a surrounding markdown code fence", () => {
    const raw = [
      "```",
      "fix(auth): null token in refresh handler",
      "",
      "Caller passed undefined when the cookie was missing.",
      "```",
    ].join("\n");
    const out = parseLLMResponse(raw);
    expect(out).not.toBeNull();
    expect(out!.split("\n")[0]).toBe("fix(auth): null token in refresh handler");
    expect(out).not.toContain("```");
  });

  it("strips a code fence with language tag", () => {
    const raw = [
      "```text",
      "docs(readme): explain quickstart steps",
      "```",
    ].join("\n");
    expect(parseLLMResponse(raw)).toBe("docs(readme): explain quickstart steps");
  });

  it("skips leading preamble lines before the header", () => {
    const raw = [
      "Sure! Here's the commit message:",
      "",
      "feat(api): add /devops-check endpoint",
      "",
      "Probes gh / glab auth status before saving the setting.",
    ].join("\n");
    const out = parseLLMResponse(raw);
    expect(out).not.toBeNull();
    expect(out!.split("\n")[0]).toBe("feat(api): add /devops-check endpoint");
    expect(out).not.toMatch(/Sure!/);
  });

  it("skips a markdown heading before the header", () => {
    const raw = [
      "# Commit message",
      "",
      "refactor(retry): extract checkEligibility helper",
    ].join("\n");
    expect(parseLLMResponse(raw)).toBe(
      "refactor(retry): extract checkEligibility helper",
    );
  });

  it("strips a Co-Authored-By trailer the model added", () => {
    const raw = [
      "feat(ui): add devops connection-check button",
      "",
      "Probes auth status before save.",
      "",
      "Co-Authored-By: Claude <noreply@anthropic.com>",
    ].join("\n");
    const out = parseLLMResponse(raw);
    expect(out).not.toBeNull();
    expect(out).not.toMatch(/Co-Authored-By/);
    expect(out).toContain("Probes auth status before save.");
  });

  it("truncates an over-long subject to the 72-char cap with an ellipsis", () => {
    const longSubject = "feat(everything): " + "x".repeat(120);
    const out = parseLLMResponse(longSubject);
    expect(out).not.toBeNull();
    const firstLine = out!.split("\n")[0];
    expect(firstLine.length).toBeLessThanOrEqual(72);
    expect(firstLine.endsWith("…")).toBe(true);
  });

  it("returns null on completely empty input", () => {
    expect(parseLLMResponse("")).toBeNull();
    expect(parseLLMResponse("   \n\n  ")).toBeNull();
  });

  it("returns null when the first non-blank line doesn't look like a header", () => {
    expect(parseLLMResponse("just some prose, no type prefix")).toBeNull();
    expect(parseLLMResponse("this is a normal sentence")).toBeNull();
  });

  it("collapses runs of blank lines in the body", () => {
    const raw = [
      "fix(meta): handle empty runs[]",
      "",
      "",
      "",
      "First body paragraph.",
      "",
      "",
      "Second body paragraph.",
    ].join("\n");
    const out = parseLLMResponse(raw);
    expect(out).not.toBeNull();
    // No 3+ consecutive newlines in the result.
    expect(out!.includes("\n\n\n")).toBe(false);
    expect(out).toContain("First body paragraph.");
    expect(out).toContain("Second body paragraph.");
  });

  it("preserves scope in header (feat(scope): subject)", () => {
    const out = parseLLMResponse("feat(commit-message): use claude -p to read diff");
    expect(out).toBe("feat(commit-message): use claude -p to read diff");
  });
});

describe("buildPrompt", () => {
  it("includes the diff-reading steps", () => {
    const p = buildPrompt({ cwd: "/x" });
    expect(p).toContain("git diff HEAD");
    expect(p).toContain("git status --porcelain");
  });

  it("mentions the task title when provided", () => {
    const p = buildPrompt({ cwd: "/x", taskTitle: "Fix the modal" });
    expect(p).toContain("Fix the modal");
  });

  it("omits the task-title section when no title", () => {
    const p = buildPrompt({ cwd: "/x" });
    expect(p).not.toContain("Context: this commit closes the task");
  });

  it("truncates a very long task title to 200 chars", () => {
    const longTitle = "x".repeat(500);
    const p = buildPrompt({ cwd: "/x", taskTitle: longTitle });
    expect(p).toContain("x".repeat(200));
    expect(p).not.toContain("x".repeat(201));
  });

  it("requires English output and Conventional Commits format", () => {
    const p = buildPrompt({ cwd: "/x" });
    expect(p).toMatch(/ENGLISH/);
    expect(p).toMatch(/Conventional Commits/);
    expect(p).toMatch(/feat \| fix/);
  });

  it("forbids code fences + co-author trailers in the output", () => {
    const p = buildPrompt({ cwd: "/x" });
    expect(p).toContain("code fences");
    expect(p).toContain("Co-Authored-By");
  });
});
