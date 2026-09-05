import { describe, it, expect, vi } from "vitest";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  countReadsBeforeEdit,
  renderPreflightRetryContextBlock,
  runPreflight,
  type PreflightResult,
} from "../preflightCheck";
import type { Run } from "../meta";

const TMP_PROJECT_DIR = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { mkdtempSync } = require("node:fs") as typeof import("node:fs");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { tmpdir } = require("node:os") as typeof import("node:os");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { join } = require("node:path") as typeof import("node:path");
  return mkdtempSync(join(tmpdir(), "bridge-preflight-project-"));
});

vi.mock("../sessions", () => ({
  projectDirFor: () => TMP_PROJECT_DIR,
}));

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

  describe("Bash commands that only read", () => {
    // Regression: t_20260905_001 — the planner surveyed the repo with 25
    // Bash calls (cat/grep/sed) and zero Read calls, so preflight reported
    // "0 Read call(s)" and escalated the task to BLOCKED.
    const bash = (command: string) => ({ name: "Bash", input: { command } });

    it("counts cat / sed -n / grep / rg / head as reads", () => {
      const text = jsonlWithInput([
        bash("cat libs/planGate.ts"),
        bash("sed -n 80,160p prompts/playbooks/planner.md"),
        bash("grep -rn intake libs/*.ts | head -30"),
        bash("rg --files-with-matches escalate libs"),
        bash("head -c 2000 sessions/t_1/plan.md"),
        { name: "Write", input: { file_path: "/repo/plan.md" } },
      ]);
      expect(countReadsBeforeEdit(text).readsBeforeEdit).toBe(5);
    });

    it("looks past a leading cd and an env assignment", () => {
      const text = jsonlWithInput([
        bash("cd /srv/test-bridge && cat libs/spawn.ts"),
        bash("cd /repo; FOO=1 sed -n 1,40p libs/meta.ts"),
        { name: "Write", input: { file_path: "/repo/plan.md" } },
      ]);
      expect(countReadsBeforeEdit(text).readsBeforeEdit).toBe(2);
    });

    it("de-duplicates the same command", () => {
      const text = jsonlWithInput([
        bash("cat libs/planGate.ts"),
        bash("cat libs/planGate.ts"),
        { name: "Write", input: { file_path: "/repo/plan.md" } },
      ]);
      expect(countReadsBeforeEdit(text).readsBeforeEdit).toBe(1);
    });

    it("does not count commands that write, run, or redirect", () => {
      const text = jsonlWithInput([
        bash("cat > sessions/t_1/plan.md <<'EOF'\nhello\nEOF"),
        bash("grep -n foo libs/a.ts > /tmp/out.txt"),
        bash("npm test"),
        bash("sed -i 's/a/b/' libs/a.ts"),
        bash("curl -s -X POST http://localhost:7777/api/tasks/t_1/link"),
        bash("rm -rf sessions/t_1"),
        bash("echo hi"),
        { name: "Write", input: { file_path: "/repo/plan.md" } },
      ]);
      expect(countReadsBeforeEdit(text).readsBeforeEdit).toBe(0);
    });

    it("still allows the usual stderr / null redirects", () => {
      const text = jsonlWithInput([
        bash("grep -rn foo libs 2>/dev/null | head"),
        bash("cat libs/a.ts 2>&1"),
        { name: "Write", input: { file_path: "/repo/plan.md" } },
      ]);
      expect(countReadsBeforeEdit(text).readsBeforeEdit).toBe(2);
    });

    it("only counts reads before the first edit, like the Read tool", () => {
      const text = jsonlWithInput([
        { name: "Write", input: { file_path: "/repo/plan.md" } },
        bash("cat libs/a.ts"),
      ]);
      expect(countReadsBeforeEdit(text).readsBeforeEdit).toBe(0);
    });
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

  it("counts editFilesCount as distinct edited files, not edit tool calls", () => {
    const text = jsonlWithInput([
      { name: "Read", input: { file_path: "/a.ts" } },
      { name: "Edit", input: { file_path: "/a.ts" } },
      { name: "Edit", input: { file_path: "/a.ts" } },
      { name: "Edit", input: { file_path: "/a.ts" } },
    ]);
    const got = countReadsBeforeEdit(text);
    expect(got.editCount).toBe(3);
    expect(got.editFilesCount).toBe(1);
  });

  it("counts editFilesCount across multiple distinct edited files", () => {
    const text = jsonlWithInput([
      { name: "Read", input: { file_path: "/a.ts" } },
      { name: "Edit", input: { file_path: "/a.ts" } },
      { name: "Edit", input: { file_path: "/b.ts" } },
      { name: "Edit", input: { file_path: "/c.ts" } },
    ]);
    expect(countReadsBeforeEdit(text).editFilesCount).toBe(3);
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
    expect(out).toContain("**Grep / Read at least 3 relevant files**");
  });
});

describe("runPreflight", () => {
  let seq = 0;

  function toolUse(
    name: string,
    input?: Record<string, unknown>,
  ): { name: string; input?: Record<string, unknown> } {
    return { name, input };
  }

  function runFrom(
    entries: Array<{ name: string; input?: Record<string, unknown> }>,
    role = "coder",
  ): Run {
    const sessionId = `test-session-${seq++}`;
    writeFileSync(join(TMP_PROJECT_DIR, `${sessionId}.jsonl`), jsonlWithInput(entries), "utf8");
    return {
      sessionId,
      role,
      repo: "test-repo",
      status: "done",
      startedAt: null,
      endedAt: null,
    };
  }

  it("exempts the planner role (and its retry alias) — it only writes plan.md/intake.json", () => {
    const entries = [toolUse("Write", { file_path: "/repo/sessions/t_1/plan.md" })];
    for (const role of ["planner", "planner-cretry", "planner-retry"]) {
      const result = runPreflight({ finishedRun: runFrom(entries, role), appPath: "/repo" });
      expect(result.verdict).toBe("skipped");
      expect(result.reason).toContain(role);
    }
  });

  it("a one-file task passes when the agent read that one file", () => {
    const entries = [
      toolUse("Read", { file_path: "/repo/math.ts" }),
      toolUse("Edit", { file_path: "/repo/math.ts" }),
    ];
    const result = runPreflight({ finishedRun: runFrom(entries), appPath: "/repo" });
    expect(result.verdict).not.toBe("fail");
    expect(result.required).toBe(1);
  });

  it("still fails a one-file task where the agent edited without reading anything", () => {
    const entries = [toolUse("Edit", { file_path: "/repo/math.ts" })];
    const result = runPreflight({ finishedRun: runFrom(entries), appPath: "/repo" });
    expect(result.verdict).toBe("fail");
    expect(result.required).toBe(1);
    expect(result.reason).toBe(
      "agent made 0 Read call(s) before the first Edit/Write — minimum is 1",
    );
  });

  it("still requires the configured minimum on a wide-footprint task", () => {
    const entries = [
      toolUse("Read", { file_path: "/repo/a.ts" }),
      toolUse("Edit", { file_path: "/repo/a.ts" }),
      toolUse("Edit", { file_path: "/repo/b.ts" }),
      toolUse("Edit", { file_path: "/repo/c.ts" }),
    ];
    const result = runPreflight({ finishedRun: runFrom(entries), appPath: "/repo" });
    expect(result.verdict).toBe("fail");
    expect(result.required).toBe(3);
    expect(result.reason).toBe(
      "agent made 1 Read call(s) before the first Edit/Write — minimum is 3",
    );
  });

  it("a two-file task requires exactly two distinct reads", () => {
    const entries = [
      toolUse("Read", { file_path: "/repo/a.ts" }),
      toolUse("Read", { file_path: "/repo/b.ts" }),
      toolUse("Edit", { file_path: "/repo/a.ts" }),
      toolUse("Edit", { file_path: "/repo/b.ts" }),
    ];
    const result = runPreflight({ finishedRun: runFrom(entries), appPath: "/repo" });
    expect(result.verdict).not.toBe("fail");
    expect(result.required).toBe(2);
  });

  it("never lowers the floor below 1 even when editFilesCount cannot be identified", () => {
    const entries = [toolUse("Edit")];
    const result = runPreflight({ finishedRun: runFrom(entries), appPath: "/repo" });
    expect(result.required).toBeGreaterThanOrEqual(1);
  });

  it("passes when the only out-of-app footprint is a report write alongside one in-app read+edit", () => {
    const entries = [
      toolUse("Read", { file_path: "/repo/math.ts" }),
      toolUse("Edit", { file_path: "/repo/math.ts" }),
      toolUse("Write", { file_path: "/bridge/sessions/t_1/reports/coder.md" }),
    ];
    const result = runPreflight({ finishedRun: runFrom(entries), appPath: "/repo" });
    expect(result.verdict).not.toBe("fail");
    expect(result.required).toBe(1);
    expect(result.readsBeforeEdit).toBe(1);
    expect(result.editCount).toBe(1);
  });

  it("still fails when the only read is out-of-app but the edit is in-app", () => {
    const entries = [
      toolUse("Read", { file_path: "/bridge/sessions/t_1/plan.md" }),
      toolUse("Edit", { file_path: "/repo/math.ts" }),
    ];
    const result = runPreflight({ finishedRun: runFrom(entries), appPath: "/repo" });
    expect(result.verdict).toBe("fail");
    expect(result.required).toBe(1);
    expect(result.readsBeforeEdit).toBe(0);
    expect(result.reason).toBe(
      "agent made 0 Read call(s) before the first Edit/Write — minimum is 1",
    );
  });
});
