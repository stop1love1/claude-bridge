import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import {
  autoApproveEnv,
  buildCoordinatorArgs,
  buildFreeSessionArgs,
  buildResumeArgs,
  denyTaskToolNames,
  resolveEffort,
} from "../spawn";
import { ULTRACODE_DIRECTIVE, withUltracodeDirective } from "../systemPrompt";
import { appendRun, createMeta, readMeta, updateRun } from "../meta";

describe("buildCoordinatorArgs", () => {
  it("pins the session-id and ends with -p (prompt is piped via stdin)", () => {
    const sessionId = "550e8400-e29b-41d4-a716-446655440000";
    const args = buildCoordinatorArgs(
      { role: "coordinator", taskId: "t_20260424_001", prompt: "Do the thing." },
      sessionId,
    );
    expect(args[0]).toBe("--session-id");
    expect(args[1]).toBe(sessionId);
    expect(args[args.length - 1]).toBe("-p");
  });

  it("requests stream-json output so stdout carries token deltas", () => {
    const args = buildCoordinatorArgs(
      { role: "coordinator", taskId: "t_x", prompt: "" },
      "id",
    );
    expect(args).toContain("--output-format");
    expect(args[args.indexOf("--output-format") + 1]).toBe("stream-json");
    expect(args).toContain("--verbose");
    expect(args).toContain("--include-partial-messages");
  });

  it("emits no model / effort / permission-mode flag when settings absent", () => {
    const args = buildCoordinatorArgs(
      { role: "coordinator", taskId: "t_x", prompt: "" },
      "id",
    );
    expect(args).not.toContain("--model");
    expect(args).not.toContain("--effort");
    expect(args).not.toContain("--permission-mode");
  });

  it("forwards valid settings as flags", () => {
    const args = buildCoordinatorArgs(
      {
        role: "coordinator",
        taskId: "t_x",
        prompt: "",
        settings: { mode: "acceptEdits", effort: "high", model: "opus" },
      },
      "id",
    );
    expect(args).toContain("--permission-mode");
    expect(args[args.indexOf("--permission-mode") + 1]).toBe("acceptEdits");
    expect(args).toContain("--effort");
    expect(args[args.indexOf("--effort") + 1]).toBe("high");
    expect(args).toContain("--model");
    expect(args[args.indexOf("--model") + 1]).toBe("opus");
  });

  it("rejects invalid settings values silently", () => {
    const args = buildCoordinatorArgs(
      {
        role: "coordinator",
        taskId: "t_x",
        prompt: "",
        // @ts-expect-error — explicitly testing runtime rejection
        settings: { mode: "rm -rf /", effort: "ULTRA", model: "../etc/passwd" },
      },
      "id",
    );
    expect(args).not.toContain("--permission-mode");
    expect(args).not.toContain("--effort");
    expect(args).not.toContain("--model");
  });

  it("emits --disallowed-tools when settings.disallowedTools is set", () => {
    const args = buildCoordinatorArgs(
      {
        role: "coordinator",
        taskId: "t_x",
        prompt: "",
        settings: { mode: "bypassPermissions", disallowedTools: ["Task"] },
      },
      "id",
    );
    const idx = args.indexOf("--disallowed-tools");
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(args[idx + 1]).toBe("Task");
  });

  it("filters disallowedTools entries that don't match the tool-name charset", () => {
    const args = buildCoordinatorArgs(
      {
        role: "coordinator",
        taskId: "t_x",
        prompt: "",
        settings: {
          disallowedTools: ["Task", "rm -rf /", "", "Bash(git *)", "--inject-flag"],
        },
      },
      "id",
    );
    const idx = args.indexOf("--disallowed-tools");
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(args.slice(idx + 1, idx + 3)).toEqual(["Task", "Bash(git *)"]);
    expect(args).not.toContain("rm -rf /");
    expect(args).not.toContain("--inject-flag");
  });

  it("emits no --disallowed-tools when the array is empty or all entries are invalid", () => {
    const a = buildCoordinatorArgs(
      { role: "coordinator", taskId: "t_x", prompt: "", settings: { disallowedTools: [] } },
      "id",
    );
    expect(a).not.toContain("--disallowed-tools");
    const b = buildCoordinatorArgs(
      {
        role: "coordinator",
        taskId: "t_x",
        prompt: "",
        settings: { disallowedTools: ["", "rm -rf", "--evil"] },
      },
      "id",
    );
    expect(b).not.toContain("--disallowed-tools");
  });

  it.each([
    "default",
    "acceptEdits",
    "plan",
    "auto",
    "bypassPermissions",
    "dontAsk",
  ] as const)("forwards the valid permission mode %s", (mode) => {
    const args = buildCoordinatorArgs(
      { role: "coordinator", taskId: "t_x", prompt: "", settings: { mode } },
      "id",
    );
    expect(args).toContain("--permission-mode");
    expect(args[args.indexOf("--permission-mode") + 1]).toBe(mode);
  });

  it.each(["low", "medium", "high", "xhigh", "max"] as const)(
    "forwards the valid effort %s",
    (effort) => {
      const args = buildCoordinatorArgs(
        { role: "coordinator", taskId: "t_x", prompt: "", settings: { effort } },
        "id",
      );
      expect(args).toContain("--effort");
      expect(args[args.indexOf("--effort") + 1]).toBe(effort);
    },
  );

  it("resolves the ultracode tier to --effort xhigh, never --effort ultracode", () => {
    const args = buildCoordinatorArgs(
      { role: "coordinator", taskId: "t_x", prompt: "", settings: { effort: "ultracode" } },
      "id",
    );
    expect(args).toContain("--effort");
    expect(args[args.indexOf("--effort") + 1]).toBe("xhigh");
    expect(args).not.toContain("ultracode");
  });

  it("rejects model strings that contain shell or path traversal characters", () => {
    const reject = ["opus 4", "../etc/passwd", "model;rm -rf /", "model$(whoami)", ""];
    for (const model of reject) {
      const args = buildCoordinatorArgs(
        { role: "coordinator", taskId: "t_x", prompt: "", settings: { model } },
        "id",
      );
      expect(args, `model=${JSON.stringify(model)} should be rejected`).not.toContain("--model");
    }
  });

  it("accepts model strings within the allowed charset", () => {
    for (const model of ["opus", "claude-3.5-sonnet", "gpt-4_turbo", "model-2024.07"]) {
      const args = buildCoordinatorArgs(
        { role: "coordinator", taskId: "t_x", prompt: "", settings: { model } },
        "id",
      );
      expect(args).toContain("--model");
      expect(args[args.indexOf("--model") + 1]).toBe(model);
    }
  });

  it("threads a settings file path through --settings before the streaming flags", () => {
    const args = buildCoordinatorArgs(
      {
        role: "coordinator",
        taskId: "t_x",
        prompt: "",
        settingsPath: "/tmp/sess.json",
      },
      "id",
    );
    const idx = args.indexOf("--settings");
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(args[idx + 1]).toBe("/tmp/sess.json");
    expect(idx).toBeLessThan(args.indexOf("--output-format"));
  });

  it("omits --settings when settingsPath is absent", () => {
    const args = buildCoordinatorArgs(
      { role: "coordinator", taskId: "t_x", prompt: "" },
      "id",
    );
    expect(args).not.toContain("--settings");
  });
});

describe("buildFreeSessionArgs — terminality (Task 28 follow-up)", () => {
  it("emits --disallowed-tools Task when denyTaskToolNames() is passed", () => {
    const args = buildFreeSessionArgs(
      { settings: { mode: "bypassPermissions", disallowedTools: denyTaskToolNames() } },
      "id",
    );
    const idx = args.indexOf("--disallowed-tools");
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(args[idx + 1]).toBe("Task");
  });

  it("the token immediately after the deny list is a flag, never a bare positional prompt", () => {
    const args = buildFreeSessionArgs(
      { settings: { mode: "bypassPermissions", disallowedTools: denyTaskToolNames() } },
      "id",
    );
    const idx = args.indexOf("--disallowed-tools");
    const afterDenyList = args[idx + 2];
    expect(afterDenyList).toBeDefined();
    expect(afterDenyList.startsWith("-")).toBe(true);
  });

  it("ends with the bare -p flag (prompt is piped via stdin, never positional)", () => {
    const args = buildFreeSessionArgs(
      { settings: { disallowedTools: denyTaskToolNames() } },
      "id",
    );
    expect(args[args.length - 1]).toBe("-p");
  });
});

describe("buildResumeArgs — terminality (Task 28 follow-up)", () => {
  it("emits --disallowed-tools Task when denyTaskToolNames() is passed", () => {
    const args = buildResumeArgs(
      { settings: { mode: "bypassPermissions", disallowedTools: denyTaskToolNames() } },
      "id",
    );
    const idx = args.indexOf("--disallowed-tools");
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(args[idx + 1]).toBe("Task");
  });

  it("the token immediately after the deny list is a flag, never a bare positional prompt", () => {
    const args = buildResumeArgs(
      { settings: { mode: "bypassPermissions", disallowedTools: denyTaskToolNames() } },
      "id",
    );
    const idx = args.indexOf("--disallowed-tools");
    expect(idx).toBeGreaterThanOrEqual(0);
    const afterDenyList = args[idx + 2];
    expect(afterDenyList).toBeDefined();
    expect(afterDenyList.startsWith("-")).toBe(true);
  });

  it("nothing in the message/prompt path can reach argv here — resumeClaude pipes it via stdin, never appends it after buildResumeArgs's output", () => {
    const args = buildResumeArgs(
      { settings: { disallowedTools: denyTaskToolNames() } },
      "id",
    );
    expect(args[args.length - 1]).toBe("--include-partial-messages");
  });
});

describe("appendRun-before-spawn (H4)", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "spawn-h4-"));
  });

  const HEADER = {
    taskId: "t_20260424_h4",
    taskTitle: "agents H4",
    taskBody: "exercise spawn-failure path",
    taskStatus: "todo" as const,
    taskSection: "TODO" as const,
    taskChecked: false,
    createdAt: "2026-04-24T10:00:00Z",
  };

  const SESSION_ID = "h4-failed-session";

  async function fakeRouteFlow(opts: { spawnThrows: boolean }) {
    await appendRun(tmp, {
      sessionId: SESSION_ID,
      role: "coder",
      repo: "fake-repo",
      status: "queued",
      startedAt: null,
      endedAt: null,
      parentSessionId: null,
    });

    try {
      if (opts.spawnThrows) {
        throw new Error("ENOENT: claude binary not on PATH");
      }
      await updateRun(tmp, SESSION_ID, {
        status: "running",
        startedAt: "2026-04-24T10:00:01Z",
      });
      return { ok: true as const };
    } catch (err) {
      await updateRun(tmp, SESSION_ID, {
        status: "failed",
        endedAt: "2026-04-24T10:00:01Z",
      });
      return { ok: false as const, error: err instanceof Error ? err.message : String(err) };
    }
  }

  it("records run as failed when spawn throws — no orphan window", async () => {
    createMeta(tmp, HEADER);
    const result = await fakeRouteFlow({ spawnThrows: true });
    expect(result.ok).toBe(false);

    const meta = readMeta(tmp);
    expect(meta).not.toBeNull();
    expect(meta!.runs).toHaveLength(1);
    const run = meta!.runs[0];
    expect(run.sessionId).toBe(SESSION_ID);
    expect(run.status).toBe("failed");
    expect(run.endedAt).toBe("2026-04-24T10:00:01Z");
    expect(run.startedAt).toBeNull();
  });

  it("promotes queued → running on successful spawn", async () => {
    createMeta(tmp, HEADER);
    const result = await fakeRouteFlow({ spawnThrows: false });
    expect(result.ok).toBe(true);

    const meta = readMeta(tmp);
    const run = meta!.runs[0];
    expect(run.status).toBe("running");
    expect(run.startedAt).toBe("2026-04-24T10:00:01Z");
    expect(run.endedAt).toBeNull();
  });
});

describe("autoApproveEnv (CRIT-1)", () => {
  it("returns BRIDGE_AUTO_APPROVE=1 only for bypassPermissions", () => {
    expect(autoApproveEnv({ mode: "bypassPermissions" })).toEqual({
      BRIDGE_AUTO_APPROVE: "1",
    });
  });

  it("returns empty for every interactive mode (popup must fire)", () => {
    expect(autoApproveEnv({ mode: "default" })).toEqual({});
    expect(autoApproveEnv({ mode: "acceptEdits" })).toEqual({});
    expect(autoApproveEnv({ mode: "plan" })).toEqual({});
    expect(autoApproveEnv({ mode: "auto" })).toEqual({});
    expect(autoApproveEnv({ mode: "dontAsk" })).toEqual({});
  });

  it("returns empty when settings or mode is absent", () => {
    expect(autoApproveEnv(undefined)).toEqual({});
    expect(autoApproveEnv({})).toEqual({});
  });
});

describe("resolveEffort", () => {
  it.each(["low", "medium", "high", "xhigh", "max"] as const)(
    "passes the real CLI level %s through unchanged, ultracode off",
    (e) => {
      expect(resolveEffort(e)).toEqual({ cliEffort: e, ultracode: false });
    },
  );

  it("maps ultracode → { cliEffort: 'xhigh', ultracode: true }", () => {
    expect(resolveEffort("ultracode")).toEqual({ cliEffort: "xhigh", ultracode: true });
  });

  it("treats undefined / unknown values as no-effort, ultracode off", () => {
    expect(resolveEffort(undefined)).toEqual({ ultracode: false });
    // @ts-expect-error — runtime rejection of an out-of-band value
    expect(resolveEffort("ULTRA")).toEqual({ ultracode: false });
  });
});

describe("withUltracodeDirective", () => {
  it("returns the base file unchanged when ultracode is off", () => {
    expect(withUltracodeDirective(undefined, false)).toBeUndefined();
    expect(withUltracodeDirective("/tmp/base.txt", false)).toBe("/tmp/base.txt");
  });

  it("writes a directive-only file when ultracode is on and there is no base", () => {
    const path = withUltracodeDirective(undefined, true);
    expect(path).toBeTruthy();
    const content = readFileSync(path!, "utf8");
    expect(content).toContain("<bridge-ultracode>");
    expect(content).toBe(ULTRACODE_DIRECTIVE);
  });
});
