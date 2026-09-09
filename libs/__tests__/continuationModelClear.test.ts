import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ChildProcess } from "node:child_process";

/**
 * `clearModel` — "this continuation must not inherit the model its session was
 * spawned with" — reaches five call sites. Two of them are operator-driven and
 * must honour it; three are automatic and must not, or a gate retry would
 * finish a half-written diff on a different model than it started on.
 *
 * The agents route (operator-driven, #5) is covered end-to-end in
 * `agentsModelPinning.test.ts`. This file covers the composer path (#1) and
 * pins down the three that must stay inheriting.
 */

const fakeChild = { on: () => { }, once: () => { } } as unknown as ChildProcess;

const resumeCalls: Array<{ settings?: { model?: string; clearModel?: boolean } }> = [];

vi.mock("../spawn", () => ({
  resumeClaude: (
    _cwd: string,
    _sessionId: string,
    _message: string,
    settings?: { model?: string; clearModel?: boolean },
  ) => {
    resumeCalls.push({ settings });
    return fakeChild;
  },
}));

vi.mock("../runLifecycle", () => ({ wireRunLifecycle: () => { } }));

const SID = "11111111-2222-3333-4444-555555555555";

vi.mock("../tasksStore", () => ({
  findTaskBySessionId: () => ({ id: "t_20260909_001" }),
}));

const priorModel = { value: null as string | null };
const taskModel = { value: null as string | null };

vi.mock("../meta", () => ({
  readMeta: () => ({
    taskModel: taskModel.value,
    runs: [
      {
        sessionId: SID,
        role: "coder",
        repo: "some-app",
        status: "done",
        startedAt: "2026-09-09T10:00:00Z",
        endedAt: "2026-09-09T10:00:30Z",
        model: priorModel.value,
      },
    ],
  }),
  updateRun: () => Promise.resolve({ applied: true, run: null }),
}));

const appRoleModels = { value: undefined as Record<string, string> | undefined };
vi.mock("../apps", () => ({
  getApp: () => ({ name: "some-app", roleModels: appRoleModels.value }),
}));

async function resume(settings?: Record<string, unknown>) {
  const { resumeSessionWithLifecycle } = await import("../resumeSession");
  resumeSessionWithLifecycle({
    cwd: "/tmp/some-app",
    sessionId: SID,
    message: "keep going",
    settings: settings as never,
  });
  return resumeCalls[0]?.settings;
}

beforeEach(() => {
  resumeCalls.length = 0;
  priorModel.value = null;
  taskModel.value = null;
  appRoleModels.value = undefined;
  vi.resetModules();
});

afterEach(() => {
  resumeCalls.length = 0;
});

describe("the composer resuming a live session", () => {
  it("re-pins the session's model when the operator says nothing about it", async () => {
    priorModel.value = "claude-opus-5";
    expect((await resume({ mode: "default" }))?.model).toBe("claude-opus-5");
  });

  it("re-pins it even when settings are omitted entirely", async () => {
    priorModel.value = "claude-opus-5";
    expect((await resume(undefined))?.model).toBe("claude-opus-5");
  });

  it("selecting Default sends clearModel and the resume spawns with no --model", async () => {
    // The bug: before `clearModel`, the picker's Default row deleted
    // `settings.model`, which is exactly what "I didn't touch the picker"
    // looks like — so the server re-pinned the session forever.
    priorModel.value = "claude-opus-5";
    expect((await resume({ clearModel: true }))?.model).toBeUndefined();
  });

  it("clearing drops the session pin only — a task pin still applies", async () => {
    priorModel.value = "claude-opus-5";
    taskModel.value = "claude-haiku-4-5";
    expect((await resume({ clearModel: true }))?.model).toBe("claude-haiku-4-5");
  });

  it("picking a model outright still wins", async () => {
    priorModel.value = "claude-opus-5";
    expect((await resume({ model: "claude-sonnet-5" }))?.model).toBe("claude-sonnet-5");
  });

  it("clearModel: false behaves exactly like the field being absent", async () => {
    priorModel.value = "claude-opus-5";
    expect((await resume({ clearModel: false }))?.model).toBe("claude-opus-5");
  });
});

describe("the automatic continuation paths cannot unpin a model", () => {
  /**
   * A source assertion rather than a behavioural one, on purpose: the property
   * being protected is that these call sites never *acquire* the ability to
   * unpin. A behavioural test can only show that they don't pass the flag
   * today, and would keep passing if someone wired an operator-supplied
   * `clearModel` into them — which is the regression worth catching, because a
   * gate retry that changes model mid-diff fails in a way nobody attributes to
   * this feature.
   *
   * `libs/telegramCommands.ts` used to be on this list for a reason that has
   * since been fixed rather than defended: `/continue` had no way to say
   * "unpin", so it could only inherit. It now takes `/continue <id> default`,
   * which makes it an operator-driven site like the composer.
   */
  const AUTOMATIC_SITES = [
    ["libs/retrySpawn.ts", "gate retry — no human in the loop"],
    ["libs/semanticVerifier.ts", "semantic-gate retry — no human in the loop"],
  ] as const;

  for (const [file, why] of AUTOMATIC_SITES) {
    it(`${file} resolves a continuation without clearModel (${why})`, () => {
      const src = readFileSync(join(process.cwd(), file), "utf8");
      const calls = src.split("resolveModelForContinuation({").slice(1);
      expect(calls.length, `${file} should still call resolveModelForContinuation`).toBeGreaterThan(0);
      for (const call of calls) {
        expect(call.slice(0, call.indexOf("});")), file).not.toContain("clearModel");
      }
    });
  }
});
