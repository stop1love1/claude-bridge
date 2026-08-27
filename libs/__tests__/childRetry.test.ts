import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Run } from "../meta";

let tempHome: string;
const VALID_SID = "0123abcd-4567-89ef-cdef-0123456789ab";
const REPO = "/home/u/proj-childretry";

beforeEach(() => {
  tempHome = mkdtempSync(join(tmpdir(), "bridge-childretry-test-"));
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

async function writeJsonl(lines: object[]): Promise<string> {
  const { pathToSlug } = await import("../sessions");
  const dir = join(tempHome, ".claude", "projects", pathToSlug(REPO));
  mkdirSync(dir, { recursive: true });
  const filePath = join(dir, `${VALID_SID}.jsonl`);
  const body = lines.map((l) => JSON.stringify(l)).join("\n") + "\n";
  writeFileSync(filePath, body);
  return filePath;
}

function assistantBlock(text: string, tools: Array<{ name: string; input: unknown }> = []) {
  return {
    type: "assistant",
    message: {
      content: [
        ...tools.map((t) => ({ type: "tool_use", name: t.name, input: t.input })),
        { type: "text", text },
      ],
    },
  };
}

describe("readFailedSessionContext (streaming tail reader)", () => {
  it("returns empty when the file does not exist", async () => {
    const { readFailedSessionContext } = await import("../childRetry");
    expect(readFailedSessionContext(VALID_SID, REPO)).toEqual({
      lastAssistantText: "",
      recentToolUses: [],
    });
  });

  it("extracts the last assistant text and the trailing tool_use blocks", async () => {
    await writeJsonl([
      { type: "user", message: { role: "user", content: "hi" } },
      assistantBlock("first response", [{ name: "Read", input: { file: "a.ts" } }]),
      { type: "user", message: { role: "user", content: "more" } },
      assistantBlock("LAST words from agent", [
        { name: "Bash", input: { cmd: "ls" } },
        { name: "Edit", input: { path: "b.ts" } },
      ]),
    ]);
    const { readFailedSessionContext } = await import("../childRetry");
    const ctx = readFailedSessionContext(VALID_SID, REPO);
    expect(ctx.lastAssistantText).toBe("LAST words from agent");
    expect(ctx.recentToolUses.map((t) => t.tool)).toEqual(["Read", "Bash", "Edit"]);
  });

  it("caps tool_use entries at the documented max", async () => {
    const tools = Array.from({ length: 12 }, (_, i) => ({ name: `T${i}`, input: { i } }));
    await writeJsonl([assistantBlock("done", tools)]);
    const { readFailedSessionContext } = await import("../childRetry");
    const ctx = readFailedSessionContext(VALID_SID, REPO);
    expect(ctx.recentToolUses.length).toBe(5);
  });

  it("handles a long file (forces multiple chunk reads)", async () => {
    const padding = "x".repeat(10000);
    const lines: object[] = [];
    for (let i = 0; i < 200; i++) {
      lines.push({ type: "user", message: { role: "user", content: padding } });
    }
    lines.push(
      assistantBlock("the actual final answer", [{ name: "Bash", input: { cmd: "echo done" } }]),
    );
    await writeJsonl(lines);
    const { readFailedSessionContext } = await import("../childRetry");
    const ctx = readFailedSessionContext(VALID_SID, REPO);
    expect(ctx.lastAssistantText).toBe("the actual final answer");
    expect(ctx.recentToolUses.map((t) => t.tool)).toEqual(["Bash"]);
  });

  it("ignores malformed jsonl lines without throwing", async () => {
    const path = await writeJsonl([{ type: "user", message: { role: "user", content: "ok" } }]);
    const fs = await import("node:fs");
    fs.appendFileSync(path, "this is not json\n");
    fs.appendFileSync(path, JSON.stringify(assistantBlock("real answer")) + "\n");
    const { readFailedSessionContext } = await import("../childRetry");
    const ctx = readFailedSessionContext(VALID_SID, REPO);
    expect(ctx.lastAssistantText).toBe("real answer");
  });

  it("returns empty for a 0-byte file", async () => {
    const { pathToSlug } = await import("../sessions");
    const dir = join(tempHome, ".claude", "projects", pathToSlug(REPO));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${VALID_SID}.jsonl`), "");
    const { readFailedSessionContext } = await import("../childRetry");
    expect(readFailedSessionContext(VALID_SID, REPO)).toEqual({
      lastAssistantText: "",
      recentToolUses: [],
    });
  });
});

describe("isEligibleForRetry (cancelled short-circuits auto-retry, C1)", () => {
  const TASK_ID = "t_20260826_001";

  beforeEach(() => {
    vi.spyOn(process, "cwd").mockReturnValue(tempHome);
  });

  async function seedTaskMeta(): Promise<void> {
    const { createMeta } = await import("../meta");
    const { SESSIONS_DIR } = await import("../paths");
    createMeta(join(SESSIONS_DIR, TASK_ID), {
      taskId: TASK_ID,
      taskTitle: "fixture task",
      taskBody: "fixture body",
      taskStatus: "doing",
      taskSection: "DOING",
      taskChecked: false,
      createdAt: "2026-08-26T09:00:00.000Z",
    });
  }

  function makeRun(overrides: Partial<Run>): Run {
    return {
      sessionId: VALID_SID,
      role: "coder",
      repo: "childretry-fixture-app",
      status: "failed",
      startedAt: "2026-08-26T10:00:00.000Z",
      endedAt: "2026-08-26T10:05:00.000Z",
      parentSessionId: "parent-1",
      ...overrides,
    };
  }

  it("does not schedule a retry for a run the operator cancelled", async () => {
    await seedTaskMeta();
    const { isEligibleForRetry } = await import("../childRetry");
    const run = makeRun({ status: "cancelled", role: "coder", parentSessionId: "parent-1" });
    const result = isEligibleForRetry(TASK_ID, run);
    expect("nextAttempt" in result).toBe(false);
  });

  it("still schedules a retry for a run that genuinely failed", async () => {
    await seedTaskMeta();
    const { isEligibleForRetry } = await import("../childRetry");
    const run = makeRun({ status: "failed", role: "coder", parentSessionId: "parent-1" });
    const result = isEligibleForRetry(TASK_ID, run);
    expect("nextAttempt" in result).toBe(true);
  });
});
