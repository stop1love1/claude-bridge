import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ChildProcess } from "node:child_process";
import type { Run } from "../meta";


const TMP_SESSIONS = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { mkdtempSync } = require("node:fs") as typeof import("node:fs");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { tmpdir } = require("node:os") as typeof import("node:os");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { join } = require("node:path") as typeof import("node:path");
  return mkdtempSync(join(tmpdir(), "bridge-qualitygate-"));
});

vi.mock("../paths", async () => {
  const actual = await vi.importActual<typeof import("../paths")>("../paths");
  return { ...actual, SESSIONS_DIR: TMP_SESSIONS };
});

const notifyGateInfraSkip = vi.fn().mockResolvedValue(undefined);
vi.mock("../gateEscalation", () => ({
  notifyGateInfraSkip: (opts: unknown) => notifyGateInfraSkip(opts),
}));

vi.mock("../meta", () => ({
  appendRun: vi.fn().mockResolvedValue(undefined),
  updateRun: vi.fn().mockResolvedValue(undefined),
}));

const getAppMock = vi.fn();
vi.mock("../apps", () => ({
  getApp: (name: string) => getAppMock(name),
}));

const loadPlaybookMock = vi.fn();
vi.mock("../playbooks", () => ({
  loadPlaybook: (role: string) => loadPlaybookMock(role),
}));

vi.mock("../houseRules", () => ({ loadHouseRules: () => null }));
vi.mock("../memory", () => ({ topMemoryEntries: () => [] }));
vi.mock("../symbolStore", () => ({ ensureFreshSymbolIndex: () => null }));
vi.mock("../styleStore", () => ({ ensureFreshStyleFingerprint: () => null }));
vi.mock("../pinnedFiles", () => ({ loadPinnedFiles: () => [] }));
vi.mock("../childPrompt", () => ({ buildChildPrompt: () => "PROMPT" }));
vi.mock("../permissionSettings", () => ({
  writeSessionSettings: (p: string) => p,
  freeSessionSettingsPath: (sid: string) => `settings-${sid}.json`,
}));

const spawnFreeSessionMock = vi.fn();
vi.mock("../spawn", () => ({
  spawnFreeSession: (...args: unknown[]) => spawnFreeSessionMock(...args),
  denyTaskToolArgs: () => ["Task"],
}));

import { runAgentGate } from "../qualityGate";

const TASK_ID = "t_20260710_004";

const finishedRun: Run = {
  sessionId: "11111111-1111-1111-1111-111111111111",
  role: "coder",
  repo: "real-app",
  status: "done",
  startedAt: null,
  endedAt: null,
  parentSessionId: "00000000-0000-0000-0000-000000000000",
};

function baseOpts() {
  return {
    appPath: "/tmp/fake-app",
    taskId: TASK_ID,
    finishedRun,
    taskTitle: "t",
    taskBody: "b",
    role: "style-critic",
    briefBody: "brief",
    verdictFileName: "style-verdict.json",
    timeoutMs: 5_000,
  };
}

function fakeChildExiting(code: number): ChildProcess {
  const ee = new EventEmitter() as unknown as ChildProcess & EventEmitter;
  setImmediate(() => ee.emit("exit", code));
  return ee;
}

beforeEach(() => {
  notifyGateInfraSkip.mockClear();
  spawnFreeSessionMock.mockReset();
  getAppMock.mockReset();
  getAppMock.mockReturnValue({ name: "real-app", path: "/tmp/fake-app" });
  loadPlaybookMock.mockReset();
  loadPlaybookMock.mockReturnValue("PLAYBOOK BODY");
});

afterAll(() => {
  try { rmSync(TMP_SESSIONS, { recursive: true, force: true }); } catch { }
});

describe("runAgentGate — infra failures notify", () => {
  it("spawn failure → skipped + notifyGateInfraSkip with the spawn error", async () => {
    spawnFreeSessionMock.mockImplementation(() => {
      throw new Error("ENOENT: claude not on PATH");
    });

    const outcome = await runAgentGate(baseOpts());

    expect(outcome.kind).toBe("skipped");
    expect(notifyGateInfraSkip).toHaveBeenCalledTimes(1);
    expect(notifyGateInfraSkip.mock.calls[0][0]).toMatchObject({
      taskId: TASK_ID,
      gate: "style-critic",
    });
    expect(notifyGateInfraSkip.mock.calls[0][0].detail).toContain("spawn failed");
    expect(notifyGateInfraSkip.mock.calls[0][0].detail).toContain("ENOENT");
  });

  it("non-zero exit → skipped + notifyGateInfraSkip with the exit code", async () => {
    spawnFreeSessionMock.mockImplementation(() => ({
      child: fakeChildExiting(1),
      sessionId: "gate-sid",
    }));

    const outcome = await runAgentGate(baseOpts());

    expect(outcome.kind).toBe("skipped");
    expect(notifyGateInfraSkip).toHaveBeenCalledTimes(1);
    expect(notifyGateInfraSkip.mock.calls[0][0]).toMatchObject({
      taskId: TASK_ID,
      gate: "style-critic",
    });
    expect(notifyGateInfraSkip.mock.calls[0][0].detail).toContain("exited with code 1");
  });

  it("clean exit but missing verdict file → skipped + notifyGateInfraSkip", async () => {
    spawnFreeSessionMock.mockImplementation(() => ({
      child: fakeChildExiting(0),
      sessionId: "gate-sid",
    }));

    const outcome = await runAgentGate(baseOpts());

    expect(outcome.kind).toBe("skipped");
    expect(notifyGateInfraSkip).toHaveBeenCalledTimes(1);
    expect(notifyGateInfraSkip.mock.calls[0][0].detail).toContain("did not write");
  });
});

describe("runAgentGate — legit precondition skips stay silent", () => {
  it("coordinator role exempt → skipped, NO notify", async () => {
    const outcome = await runAgentGate({
      ...baseOpts(),
      finishedRun: { ...finishedRun, role: "coordinator" },
    });
    expect(outcome.kind).toBe("skipped");
    expect(notifyGateInfraSkip).not.toHaveBeenCalled();
  });

  it("app not registered → skipped, NO notify", async () => {
    getAppMock.mockReturnValue(null);
    const outcome = await runAgentGate(baseOpts());
    expect(outcome.kind).toBe("skipped");
    expect(notifyGateInfraSkip).not.toHaveBeenCalled();
  });

  it("playbook missing → skipped, NO notify", async () => {
    loadPlaybookMock.mockReturnValue(null);
    const outcome = await runAgentGate(baseOpts());
    expect(outcome.kind).toBe("skipped");
    expect(notifyGateInfraSkip).not.toHaveBeenCalled();
  });
});

describe("runAgentGate — happy path", () => {
  it("clean exit with a parseable verdict → spawned, NO notify", async () => {
    spawnFreeSessionMock.mockImplementation(() => ({
      child: fakeChildExiting(0),
      sessionId: "gate-sid",
    }));
    const dir = join(TMP_SESSIONS, TASK_ID);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "style-verdict.json"),
      JSON.stringify({ verdict: "match", reason: "fits", issues: [] }),
    );

    const outcome = await runAgentGate(baseOpts());

    expect(outcome.kind).toBe("spawned");
    if (outcome.kind === "spawned") {
      expect(outcome.verdict).toMatchObject({ verdict: "match" });
    }
    expect(notifyGateInfraSkip).not.toHaveBeenCalled();
  });

  it("threads disallowedTools:[Task] into the agent-gate spawn (Task 28)", async () => {
    spawnFreeSessionMock.mockImplementation(() => ({
      child: fakeChildExiting(0),
      sessionId: "gate-sid",
    }));
    const dir = join(TMP_SESSIONS, TASK_ID);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "style-verdict.json"),
      JSON.stringify({ verdict: "match", reason: "fits", issues: [] }),
    );

    await runAgentGate(baseOpts());

    expect(spawnFreeSessionMock).toHaveBeenCalledTimes(1);
    const settings = spawnFreeSessionMock.mock.calls[0][2];
    expect(settings.disallowedTools).toContain("Task");
  });
});
