import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolve as resolvePath } from "node:path";
import { readOnlyChildArgs, denyTaskToolNames } from "../spawn";
import { buildTelegramIntentArgs } from "../telegramIntent";
import { buildDetectLLMArgs } from "../detect/llm";
import { buildProfileLLMArgs } from "../repoProfileLlm";
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

describe("repoProfileLlm argv", () => {
  it("includes --disallowed-tools", () => {
    const args = buildProfileLLMArgs("profile this repo");
    expect(args).toContain("--disallowed-tools");
    for (const tool of REQUIRED_DENIALS) {
      expect(args).toContain(tool);
    }
  });

  it("places the prompt before --disallowed-tools so the CLI's variadic flag parser can't swallow it", () => {
    const args = buildProfileLLMArgs("profile this repo");
    const promptIdx = args.indexOf("profile this repo");
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

describe("denyTaskToolNames (Task 28)", () => {
  it("denies only Task — never the broader read-only denial list", () => {
    const args = denyTaskToolNames();
    expect(args).toEqual(["Task"]);
    expect(args).not.toContain("Bash");
    expect(args).not.toContain("Edit");
  });
});

const TMP_ROOT = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { mkdtempSync } = require("node:fs") as typeof import("node:fs");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { tmpdir } = require("node:os") as typeof import("node:os");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { join } = require("node:path") as typeof import("node:path");
  return mkdtempSync(join(tmpdir(), "bridge-task28-"));
});

vi.mock("../paths", async () => {
  const actual = await vi.importActual<typeof import("../paths")>("../paths");
  return { ...actual, SESSIONS_DIR: TMP_ROOT };
});

const resumeSessionWithLifecycleMock = vi.fn();
vi.mock("../resumeSession", () => ({
  resumeSessionWithLifecycle: (...args: unknown[]) => resumeSessionWithLifecycleMock(...args),
}));

const spawnFreeSessionMock = vi.fn();
const resumeClaudeMock = vi.fn();
vi.mock("../spawn", async () => {
  const actual = await vi.importActual<typeof import("../spawn")>("../spawn");
  return {
    ...actual,
    spawnFreeSession: (...args: unknown[]) => spawnFreeSessionMock(...args),
    resumeClaude: (...args: unknown[]) => resumeClaudeMock(...args),
  };
});

vi.mock("../sessionEvents", async () => {
  const actual = await vi.importActual<typeof import("../sessionEvents")>("../sessionEvents");
  return { ...actual, isAlive: () => false };
});

vi.mock("../repos", async () => {
  const actual = await vi.importActual<typeof import("../repos")>("../repos");
  return { ...actual, resolveRepoCwd: () => "/tmp/fake-semantic-repo" };
});

vi.mock("../apps", async () => {
  const actual = await vi.importActual<typeof import("../apps")>("../apps");
  return { ...actual, getApp: () => null };
});

vi.mock("../permissionSettings", async () => {
  const actual = await vi.importActual<typeof import("../permissionSettings")>("../permissionSettings");
  return {
    ...actual,
    writeSessionSettings: (p: string) => p,
    freeSessionSettingsPath: (sid: string) => `settings-${sid}.json`,
  };
});

vi.mock("../promptStore", () => ({
  readOriginalPrompt: () => "",
}));

vi.mock("../retryLadder", () => ({
  checkEligibility: () => ({ eligible: true, nextAttempt: 1 }),
  maxAttemptsFor: () => 3,
  parseRole: (role: string) => ({ baseRole: role, gate: null, attempt: 0 }),
  nextRetryRole: () => "coder-svretry",
  renderStrategyPrefix: () => "PREFIX",
}));

vi.mock("../coordinator", async () => {
  const actual = await vi.importActual<typeof import("../coordinator")>("../coordinator");
  return { ...actual, wireRunLifecycle: vi.fn() };
});

const HEADER = {
  taskTitle: "task 28 spawn-site probe",
  taskBody: "",
  taskStatus: "doing" as const,
  taskSection: "DOING" as const,
  taskChecked: false,
  createdAt: "2026-08-27T10:00:00Z",
};

describe("coordinatorNudge — resume settings deny Task (Task 28)", () => {
  const TASK_ID = "t_20260827_101";

  async function taskDir() {
    const { join } = await import("node:path");
    return join(TMP_ROOT, TASK_ID);
  }

  beforeEach(() => {
    resumeSessionWithLifecycleMock.mockClear();
  });

  afterEach(async () => {
    const { rmSync } = await import("node:fs");
    try { rmSync(await taskDir(), { recursive: true, force: true }); } catch { }
  });

  it("threads disallowedTools:[Task] into the coordinator-nudge resume", async () => {
    const { _resetCoordinatorNudgeForTest, scheduleCoordinatorEvaluation } = await import("../coordinatorNudge");
    const { createMeta, appendRun } = await import("../meta");
    _resetCoordinatorNudgeForTest();

    const dir = await taskDir();
    const coordSid = "11111111-2222-3333-4444-555555555555";
    createMeta(dir, { taskId: TASK_ID, ...HEADER });
    await appendRun(dir, {
      sessionId: coordSid,
      role: "coordinator",
      repo: "claude-bridge",
      status: "running",
      startedAt: "2026-08-27T10:00:00Z",
      endedAt: null,
    });
    await appendRun(dir, {
      sessionId: "22222222-2222-3333-4444-555555555555",
      role: "coder",
      repo: "claude-bridge",
      status: "done",
      startedAt: "2026-08-27T10:00:01Z",
      endedAt: "2026-08-27T10:00:02Z",
      parentSessionId: coordSid,
    });

    scheduleCoordinatorEvaluation(TASK_ID, coordSid, "test");
    await new Promise((r) => setTimeout(r, 300));

    expect(resumeSessionWithLifecycleMock).toHaveBeenCalledTimes(1);
    const settings = resumeSessionWithLifecycleMock.mock.calls[0][0].settings;
    expect(settings.disallowedTools).toContain("Task");
  });
});

describe("semanticVerifier — retry-spawn settings deny Task (Task 28)", () => {
  const TASK_ID = "t_20260827_103";

  beforeEach(() => {
    spawnFreeSessionMock.mockReset();
    spawnFreeSessionMock.mockImplementation(() => ({
      child: { once: () => { } },
      sessionId: "svretry-sid",
    }));
  });

  async function taskDir() {
    const { join } = await import("node:path");
    return join(TMP_ROOT, TASK_ID);
  }

  afterEach(async () => {
    const { rmSync } = await import("node:fs");
    try { rmSync(await taskDir(), { recursive: true, force: true }); } catch { }
  });

  it("threads disallowedTools:[Task] into the semantic-verifier retry spawn", async () => {
    const { spawnSemanticVerifierRetry } = await import("../semanticVerifier");
    const { createMeta, appendRun } = await import("../meta");

    const finishedRun = {
      sessionId: "coder-1",
      role: "coder",
      repo: "claude-bridge",
      status: "done" as const,
      startedAt: null,
      endedAt: null,
      parentSessionId: "coord-1",
    };
    const verifier = {
      verdict: "broken" as const,
      reason: "does not implement the task body",
      concerns: [],
      durationMs: 1,
    };

    const dir = await taskDir();
    createMeta(dir, { taskId: TASK_ID, ...HEADER });
    await appendRun(dir, finishedRun);

    await spawnSemanticVerifierRetry({ taskId: TASK_ID, finishedRun, verifier });

    expect(spawnFreeSessionMock).toHaveBeenCalledTimes(1);
    const settings = spawnFreeSessionMock.mock.calls[0][2];
    expect(settings.disallowedTools).toContain("Task");
  });
});

describe("telegramCommands /continue — resume settings deny Task (Task 28)", () => {
  const TASK_ID = "t_20260827_104";

  async function taskDir() {
    const { join } = await import("node:path");
    return join(TMP_ROOT, TASK_ID);
  }

  beforeEach(() => {
    resumeClaudeMock.mockReset();
    resumeClaudeMock.mockReturnValue({ once: () => { } });
  });

  afterEach(async () => {
    const { rmSync } = await import("node:fs");
    try { rmSync(await taskDir(), { recursive: true, force: true }); } catch { }
  });

  it("threads disallowedTools:[Task] into the /continue resume", async () => {
    const { dispatchCommand } = await import("../telegramCommands");
    const { createMeta, appendRun } = await import("../meta");

    const dir = await taskDir();
    createMeta(dir, { taskId: TASK_ID, ...HEADER });
    await appendRun(dir, {
      sessionId: "coord-continue-1",
      role: "coordinator",
      repo: "claude-bridge",
      status: "done",
      startedAt: "2026-08-27T10:00:00Z",
      endedAt: "2026-08-27T10:05:00Z",
    });

    const reply = await dispatchCommand(`/continue ${TASK_ID}`);

    expect(reply).toMatch(/Resumed coordinator/);
    expect(resumeClaudeMock).toHaveBeenCalledTimes(1);
    const settings = resumeClaudeMock.mock.calls[0][3];
    expect(settings.disallowedTools).toContain("Task");
  });
});

describe("planGateLifecycle continueCoordinator — resume settings deny Task (Task 28)", () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const NodeModule = require("node:module") as typeof import("node:module") & {
    _resolveFilename: (
      request: string,
      parent: NodeJS.Module | null,
      isMain?: boolean,
      options?: object,
    ) => string;
    _cache: Record<string, NodeJS.Module>;
  };
  const originalResolve = NodeModule._resolveFilename;
  const TASK_ID = "t_20260827_105";

  function seedPlanGateRequireCache() {
    const libsDir = resolvePath(__dirname, "..");
    const fakes: Record<string, object> = {
      resumeSession: {
        resumeSessionWithLifecycle: (...args: unknown[]) => resumeSessionWithLifecycleMock(...args),
      },
      coordinator: {
        spawnCoordinatorForTask: vi.fn(),
        wireRunLifecycle: vi.fn(),
      },
      paths: { BRIDGE_ROOT: "/tmp/fake-bridge-root" },
      spawn: { denyTaskToolNames: () => ["Task"] },
    };
    const fakeKeyFor: Record<string, string> = {};
    for (const [name, mod] of Object.entries(fakes)) {
      const filename = resolvePath(libsDir, name + ".ts");
      fakeKeyFor[name] = filename;
      NodeModule._cache[filename] = {
        id: filename,
        filename,
        loaded: true,
        exports: mod,
        children: [],
        paths: [],
      } as unknown as NodeJS.Module;
    }
    NodeModule._resolveFilename = function patched(
      request: string,
      parent: NodeJS.Module | null,
      isMain?: boolean,
      options?: object,
    ): string {
      if (request.startsWith("./")) {
        const bare = request.slice(2);
        if (bare in fakeKeyFor) return fakeKeyFor[bare];
      }
      return originalResolve.call(this, request, parent, isMain, options);
    };
  }

  async function taskDir() {
    const { join } = await import("node:path");
    return join(TMP_ROOT, TASK_ID);
  }

  beforeEach(() => {
    resumeSessionWithLifecycleMock.mockClear();
    seedPlanGateRequireCache();
  });

  afterEach(async () => {
    NodeModule._resolveFilename = originalResolve;
    const { rmSync } = await import("node:fs");
    try { rmSync(await taskDir(), { recursive: true, force: true }); } catch { }
  });

  it("threads disallowedTools:[Task] into the plan-gate continuation resume", async () => {
    const { continueCoordinator } = await import("../planGateLifecycle");
    const { createMeta, appendRun } = await import("../meta");

    const dir = await taskDir();
    createMeta(dir, { taskId: TASK_ID, ...HEADER });
    await appendRun(dir, {
      sessionId: "coord-plangate-1",
      role: "coordinator",
      repo: "claude-bridge",
      status: "done",
      startedAt: "2026-08-27T10:00:00Z",
      endedAt: "2026-08-27T10:05:00Z",
    });

    await continueCoordinator(TASK_ID, dir, "plan approved");

    expect(resumeSessionWithLifecycleMock).toHaveBeenCalledTimes(1);
    const settings = resumeSessionWithLifecycleMock.mock.calls[0][0].settings;
    expect(settings.disallowedTools).toContain("Task");
  });
});
