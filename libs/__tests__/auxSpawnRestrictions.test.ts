import { describe, it, expect } from "vitest";
import { readOnlyChildArgs } from "../spawn";
import { buildTelegramIntentArgs } from "../telegramIntent";
import { buildDetectLLMArgs } from "../detect/llm";
import { buildScanAppArgs, PROMPT as SCAN_APP_PROMPT } from "../scanApp";
import { buildCommitMessageArgs } from "../commitMessage";

const REQUIRED_DENIALS = ["Bash", "Write", "Edit", "MultiEdit", "NotebookEdit", "WebFetch", "Task"];

describe("readOnlyChildArgs", () => {
  it("every auxiliary claude spawn denies write and shell tools", () => {
    const args = readOnlyChildArgs();
    expect(args[0]).toBe("--disallowed-tools");
    const denied = args.slice(1);
    for (const tool of REQUIRED_DENIALS) {
      expect(denied).toContain(tool);
    }
  });
});

describe("telegramIntent argv", () => {
  it("includes --disallowed-tools", () => {
    const args = buildTelegramIntentArgs("route this message");
    expect(args).toContain("--disallowed-tools");
    for (const tool of REQUIRED_DENIALS) {
      expect(args).toContain(tool);
    }
  });

  it("places the prompt before --disallowed-tools so the CLI's variadic flag parser can't swallow it", () => {
    const args = buildTelegramIntentArgs("route this message");
    const promptIdx = args.indexOf("route this message");
    const flagIdx = args.indexOf("--disallowed-tools");
    expect(promptIdx).toBeGreaterThanOrEqual(0);
    expect(flagIdx).toBeGreaterThan(promptIdx);
  });
});

describe("detect/llm argv", () => {
  it("includes --disallowed-tools", () => {
    const args = buildDetectLLMArgs("detect this scope");
    expect(args).toContain("--disallowed-tools");
    for (const tool of REQUIRED_DENIALS) {
      expect(args).toContain(tool);
    }
  });

  it("places the prompt before --disallowed-tools so the CLI's variadic flag parser can't swallow it", () => {
    const args = buildDetectLLMArgs("detect this scope");
    const promptIdx = args.indexOf("detect this scope");
    const flagIdx = args.indexOf("--disallowed-tools");
    expect(promptIdx).toBeGreaterThanOrEqual(0);
    expect(flagIdx).toBeGreaterThan(promptIdx);
  });
});

describe("scanApp argv", () => {
  it("includes --disallowed-tools", () => {
    const args = buildScanAppArgs();
    expect(args).toContain("--disallowed-tools");
    for (const tool of REQUIRED_DENIALS) {
      expect(args).toContain(tool);
    }
  });

  it("places the prompt before --disallowed-tools so the CLI's variadic flag parser can't swallow it", () => {
    const args = buildScanAppArgs();
    const promptIdx = args.indexOf(SCAN_APP_PROMPT);
    const flagIdx = args.indexOf("--disallowed-tools");
    expect(promptIdx).toBeGreaterThanOrEqual(0);
    expect(flagIdx).toBeGreaterThan(promptIdx);
  });
});

describe("commitMessage argv", () => {
  it("includes --disallowed-tools", () => {
    const args = buildCommitMessageArgs();
    expect(args).toContain("--disallowed-tools");
    for (const tool of REQUIRED_DENIALS) {
      expect(args).toContain(tool);
    }
  });
});
