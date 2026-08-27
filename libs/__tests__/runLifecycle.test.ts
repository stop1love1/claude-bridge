import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve as resolvePath } from "node:path";
import type { ChildProcess } from "node:child_process";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const Module = require("node:module") as typeof import("node:module") & {
  _resolveFilename: (
    request: string,
    parent: NodeJS.Module | null,
    isMain?: boolean,
    options?: object,
  ) => string;
  _cache: Record<string, NodeJS.Module>;
};
const originalResolve = Module._resolveFilename;

function seedRequireCache(overrides: Record<string, object> = {}) {
  const libsDir = resolvePath(__dirname, "..");
  const fakes: Record<string, object> = {
    verifyChain: {
      verifyConfigOf: () => null,
      hasAnyVerifyCommand: () => false,
      isAlreadyRetryRun: () => false,
      runVerifyChain: async () => null,
      spawnVerifyRetry: async () => null,
      isEligibleForVerifyRetry: () => false,
    },
    verifier: {
      runVerifier: async () => null,
      spawnClaimRetry: async () => null,
      isEligibleForClaimRetry: () => false,
    },
    preflightCheck: {
      runPreflight: () => null,
      spawnPreflightRetry: async () => null,
      isEligibleForPreflightRetry: () => false,
    },
    styleCritic: {
      runStyleCritic: async () => null,
      spawnStyleCriticRetry: async () => null,
      isEligibleForStyleCriticRetry: () => false,
    },
    semanticVerifier: {
      runSemanticVerifier: async () => null,
      spawnSemanticVerifierRetry: async () => null,
      isEligibleForSemanticVerifierRetry: () => false,
    },
    childRetry: { maybeScheduleRetry: () => undefined },
    permissionSettings: { cleanupSessionSettings: () => undefined },
    speculative: {
      claimSpeculativeWinner: async () => ({
        proceed: true,
        outcome: "n/a",
        reason: "test",
        killed: [],
      }),
    },
    memoryDistill: {
      runMemoryDistill: async () => ({
        appended: 0,
        reason: "test",
        distillSessionId: null,
      }),
    },
  };
  const fakeKeyFor: Record<string, string> = {};
  for (const [name, mod] of Object.entries(fakes)) {
    const filename = resolvePath(libsDir, name + ".ts");
    fakeKeyFor[name] = filename;
    Module._cache[filename] = {
      id: filename,
      filename,
      loaded: true,
      exports: { ...mod, ...(overrides[name] ?? {}) },
      children: [],
      paths: [],
    } as unknown as NodeJS.Module;
  }
  Module._resolveFilename = function patched(
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


vi.mock("../verifyChain", () => ({
  verifyConfigOf: () => null,
  hasAnyVerifyCommand: () => false,
  isAlreadyRetryRun: () => false,
  runVerifyChain: vi.fn(),
  spawnVerifyRetry: vi.fn(),
  isEligibleForVerifyRetry: () => false,
}));
vi.mock("../verifier", () => ({
  runVerifier: vi.fn().mockResolvedValue(null),
  spawnClaimRetry: vi.fn(),
  isEligibleForClaimRetry: () => false,
}));
vi.mock("../preflightCheck", () => ({
  runPreflight: () => null,
  spawnPreflightRetry: vi.fn(),
  isEligibleForPreflightRetry: () => false,
}));
vi.mock("../styleCritic", () => ({
  runStyleCritic: vi.fn().mockResolvedValue(null),
  spawnStyleCriticRetry: vi.fn(),
  isEligibleForStyleCriticRetry: () => false,
}));
vi.mock("../semanticVerifier", () => ({
  runSemanticVerifier: vi.fn().mockResolvedValue(null),
  spawnSemanticVerifierRetry: vi.fn(),
  isEligibleForSemanticVerifierRetry: () => false,
}));

vi.mock("../childRetry", () => ({
  maybeScheduleRetry: vi.fn(),
}));

vi.mock("../permissionSettings", () => ({
  cleanupSessionSettings: vi.fn(),
}));

const getAppMock = vi.fn();
vi.mock("../apps", () => ({
  getApp: (name: string) => getAppMock(name),
  loadApps: () => [],
  isValidAppName: () => true,
  semanticVerifierEnabled: (app: { quality?: { verifier?: boolean } }) =>
    app.quality?.verifier !== false,
  resolvePanelSize: (app: { quality?: { verifierPanel?: number } }) => {
    const n = app.quality?.verifierPanel;
    return typeof n === "number" && Number.isFinite(n) ? Math.max(1, Math.min(5, Math.floor(n))) : 3;
  },
}));

vi.mock("../paths", async () => {
  const actual = await vi.importActual<typeof import("../paths")>("../paths");
  return {
    ...actual,
    readBridgeMd: () => "",
  };
});

vi.mock("../gitOps", () => ({
  autoCommitAndPush: vi.fn(),
  mergeIntoTargetBranch: vi.fn(),
  readCurrentBranch: vi.fn().mockReturnValue(null),
}));
vi.mock("../worktrees", () => ({
  mergeAndRemoveWorktree: vi.fn(),
}));
vi.mock("../devops", () => ({
  runDevopsAgent: vi.fn(),
}));

vi.mock("../gateEscalation", () => ({
  escalateGateBlock: vi.fn(),
  notifyGateInfraSkip: vi.fn(),
}));

let tmp: string;
const SID = "11111111-2222-3333-4444-555555555555";
const TASK_HEADER = {
  taskId: "t_20260424_001",
  taskTitle: "test task",
  taskBody: "test body",
  taskStatus: "doing" as const,
  taskSection: "DOING" as const,
  taskChecked: false,
  createdAt: "2026-04-24T10:00:00Z",
};

beforeEach(() => {
  vi.resetModules();
  tmp = mkdtempSync(join(tmpdir(), "runlifecycle-"));
  getAppMock.mockReset();
  getAppMock.mockReturnValue(null);
  seedRequireCache();
});

afterEach(() => {
  try { rmSync(tmp, { recursive: true, force: true }); } catch { }
  Module._resolveFilename = originalResolve;
});

function makeFakeChild(): ChildProcess & { emit: (ev: string, ...args: unknown[]) => boolean } {
  const ee = new EventEmitter();
  return ee as unknown as ChildProcess & { emit: (ev: string, ...args: unknown[]) => boolean };
}

async function flushAsync(times = 3): Promise<void> {
  for (let i = 0; i < times; i++) {
    await new Promise((r) => setImmediate(r));
  }
}

describe("wireRunLifecycle — state transitions", () => {
  it("flips running → done on a clean coordinator exit (code 0)", async () => {
    const { createMeta, appendRun, readMeta } = await import("../meta");
    const { wireRunLifecycle } = await import("../runLifecycle");

    createMeta(tmp, TASK_HEADER);
    await appendRun(tmp, {
      sessionId: SID,
      role: "coordinator",
      repo: "fake-repo",
      status: "running",
      startedAt: "2026-04-24T10:00:01Z",
      endedAt: null,
    });

    const child = makeFakeChild();
    wireRunLifecycle(tmp, SID, child, "fake-repo", "test-coordinator");
    child.emit("exit", 0, null);
    await flushAsync(8);

    const meta = readMeta(tmp);
    const run = meta?.runs.find((r) => r.sessionId === SID);
    expect(run?.status).toBe("done");
    expect(run?.endedAt).toBeTruthy();
  });

  it("flips running → failed on a non-zero exit", async () => {
    const { createMeta, appendRun, readMeta } = await import("../meta");
    const { wireRunLifecycle } = await import("../runLifecycle");

    createMeta(tmp, TASK_HEADER);
    await appendRun(tmp, {
      sessionId: SID,
      role: "coordinator",
      repo: "fake-repo",
      status: "running",
      startedAt: "2026-04-24T10:00:01Z",
      endedAt: null,
    });

    const child = makeFakeChild();
    wireRunLifecycle(tmp, SID, child, "fake-repo", "test-coordinator");
    child.emit("exit", 1, null);
    await flushAsync();

    const meta = readMeta(tmp);
    const run = meta?.runs.find((r) => r.sessionId === SID);
    expect(run?.status).toBe("failed");
    expect(run?.endedAt).toBeTruthy();
  });

  it("treats a signal-only exit (code=null) as failed so the run isn't stuck running", async () => {
    const { createMeta, appendRun, readMeta } = await import("../meta");
    const { wireRunLifecycle } = await import("../runLifecycle");

    createMeta(tmp, TASK_HEADER);
    await appendRun(tmp, {
      sessionId: SID,
      role: "coder",
      repo: "fake-repo",
      status: "running",
      startedAt: "2026-04-24T10:00:01Z",
      endedAt: null,
    });

    const child = makeFakeChild();
    wireRunLifecycle(tmp, SID, child, "fake-repo", "test-signal-kill");
    child.emit("exit", null, "SIGTERM");
    await flushAsync();

    const meta = readMeta(tmp);
    const run = meta?.runs.find((r) => r.sessionId === SID);
    expect(run?.status).toBe("failed");
  });

  it("does NOT demote a row that is already `done` when the exit handler later fires (succeedRun precondition)", async () => {
    const { createMeta, appendRun, readMeta, updateRun } = await import("../meta");
    const { wireRunLifecycle } = await import("../runLifecycle");

    createMeta(tmp, TASK_HEADER);
    await appendRun(tmp, {
      sessionId: SID,
      role: "coordinator",
      repo: "fake-repo",
      status: "running",
      startedAt: "2026-04-24T10:00:01Z",
      endedAt: null,
    });
    await updateRun(tmp, SID, { status: "done", endedAt: "2026-04-24T10:00:02Z" });

    const child = makeFakeChild();
    wireRunLifecycle(tmp, SID, child, "fake-repo", "tag");
    child.emit("exit", 0, null);
    await flushAsync();

    const meta = readMeta(tmp);
    const run = meta?.runs.find((r) => r.sessionId === SID);
    expect(run?.status).toBe("done");
    expect(run?.endedAt).toBe("2026-04-24T10:00:02Z");
  });

  it("does NOT demote a row that is already `failed` when a non-zero exit fires (failRun precondition)", async () => {
    const { createMeta, appendRun, readMeta, updateRun } = await import("../meta");
    const { wireRunLifecycle } = await import("../runLifecycle");

    createMeta(tmp, TASK_HEADER);
    await appendRun(tmp, {
      sessionId: SID,
      role: "coordinator",
      repo: "fake-repo",
      status: "running",
      startedAt: "2026-04-24T10:00:01Z",
      endedAt: null,
    });
    await updateRun(tmp, SID, {
      status: "failed",
      endedAt: "2026-04-24T10:00:02Z",
    });

    const child = makeFakeChild();
    wireRunLifecycle(tmp, SID, child, "fake-repo", "tag");
    child.emit("exit", 137, null);
    await flushAsync();

    const meta = readMeta(tmp);
    const run = meta?.runs.find((r) => r.sessionId === SID);
    expect(run?.status).toBe("failed");
    expect(run?.endedAt).toBe("2026-04-24T10:00:02Z");
  });

  it("calls failRun on `child.error` (spawn failure path)", async () => {
    const { createMeta, appendRun, readMeta } = await import("../meta");
    const { wireRunLifecycle } = await import("../runLifecycle");

    createMeta(tmp, TASK_HEADER);
    await appendRun(tmp, {
      sessionId: SID,
      role: "coordinator",
      repo: "fake-repo",
      status: "running",
      startedAt: null,
      endedAt: null,
    });

    const child = makeFakeChild();
    wireRunLifecycle(tmp, SID, child, "fake-repo", "tag");
    child.emit("error", new Error("ENOENT: claude not on PATH"));
    await flushAsync();

    const meta = readMeta(tmp);
    const run = meta?.runs.find((r) => r.sessionId === SID);
    expect(run?.status).toBe("failed");
    expect(run?.endedAt).toBeTruthy();
  });

  it("DEFERS the running → done flip when an app is registered and the run isn't a coordinator (succeedRun gate-defer guard)", async () => {
    const { createMeta, appendRun, readMeta } = await import("../meta");
    const { wireRunLifecycle } = await import("../runLifecycle");

    createMeta(tmp, TASK_HEADER);
    await appendRun(tmp, {
      sessionId: SID,
      role: "coder",
      repo: "real-app",
      status: "running",
      startedAt: "2026-04-24T10:00:01Z",
      endedAt: null,
    });

    getAppMock.mockReturnValue({
      name: "real-app",
      path: "/tmp/fake-app",
      git: { branchMode: "current", worktreeMode: "disabled", autoCommit: false, autoPush: false, mergeTargetBranch: "", integrationMode: "none" },
      verify: {},
      quality: { critic: false, verifier: false },
      retry: {},
      memory: { distill: false },
    });

    const child = makeFakeChild();
    wireRunLifecycle(tmp, SID, child, "real-app", "tag");
    child.emit("exit", 0, null);
    await flushAsync(8);

    const meta = readMeta(tmp);
    const run = meta?.runs.find((r) => r.sessionId === SID);
    expect(run?.status).toBe("running");
    expect(run?.endedAt).toBeNull();
  });

  it("does not write to a non-existent run (lookup miss) — meta stays untouched", async () => {
    const { createMeta, appendRun, readMeta } = await import("../meta");
    const { wireRunLifecycle } = await import("../runLifecycle");

    createMeta(tmp, TASK_HEADER);
    await appendRun(tmp, {
      sessionId: "other-sid",
      role: "coordinator",
      repo: "fake-repo",
      status: "running",
      startedAt: null,
      endedAt: null,
    });

    const child = makeFakeChild();
    wireRunLifecycle(tmp, SID, child, "fake-repo", "tag");
    child.emit("exit", 0, null);
    await flushAsync();

    const meta = readMeta(tmp);
    const other = meta?.runs.find((r) => r.sessionId === "other-sid");
    expect(other?.status).toBe("running");
    expect(meta?.runs.find((r) => r.sessionId === SID)).toBeUndefined();
  });
});

describe("postExitFlow — escalateGateBlock call-site wiring", () => {
  const REAL_APP = {
    name: "real-app",
    path: "/tmp/fake-app",
    git: { branchMode: "current", worktreeMode: "disabled", autoCommit: false, autoPush: false, mergeTargetBranch: "", integrationMode: "none" },
    verify: {},
    quality: { critic: false, verifier: false },
    retry: {},
    memory: { distill: false },
  };

  async function driveExit(appOverrides: object = {}) {
    const { createMeta, appendRun } = await import("../meta");
    const ge = await import("../gateEscalation");
    const { wireRunLifecycle } = await import("../runLifecycle");
    vi.mocked(ge.escalateGateBlock).mockClear();

    createMeta(tmp, TASK_HEADER);
    await appendRun(tmp, {
      sessionId: SID,
      role: "coder",
      repo: "real-app",
      status: "running",
      startedAt: "2026-04-24T10:00:01Z",
      endedAt: null,
      parentSessionId: "00000000-0000-0000-0000-000000000000",
    });
    getAppMock.mockReturnValue({ ...REAL_APP, ...appOverrides });

    const child = makeFakeChild();
    wireRunLifecycle(tmp, SID, child, "real-app", "tag");
    child.emit("exit", 0, null);
    await flushAsync(10);

    return vi.mocked(ge.escalateGateBlock).mock.calls;
  }

  it("verify-crash branch escalates with gate:'verify' and the inconclusive reason", async () => {
    seedRequireCache({
      verifyChain: {
        verifyConfigOf: () => ({ test: "x" }),
        hasAnyVerifyCommand: () => true,
        runVerifyChain: async () => { throw new Error("boom"); },
      },
    });
    const calls = await driveExit();
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toMatchObject({
      taskId: basename(tmp),
      sessionsDir: tmp,
      gate: "verify",
      reason: "verify chain crashed — inconclusive",
      retryScheduled: false,
    });
  });

  it("verify-fail with ineligible retry escalates with gate:'verify' and the failed step name", async () => {
    seedRequireCache({
      verifyChain: {
        verifyConfigOf: () => ({ test: "x" }),
        hasAnyVerifyCommand: () => true,
        runVerifyChain: async () => ({
          steps: [{ name: "test", ok: false, exitCode: 1, durationMs: 1, output: "" }],
          passed: false,
          startedAt: "2026-04-24T10:00:02Z",
          endedAt: "2026-04-24T10:00:03Z",
        }),
      },
    });
    const calls = await driveExit();
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toMatchObject({ gate: "verify", retryScheduled: false });
    expect((calls[0][0] as { reason: string }).reason).toContain("chain failed at `test`");
  });

  it("preflight-fail with ineligible retry escalates with gate:'preflight'", async () => {
    seedRequireCache({
      preflightCheck: {
        runPreflight: () => ({ verdict: "fail", reason: "read 0 files before editing" }),
      },
    });
    const calls = await driveExit();
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toMatchObject({ gate: "preflight", retryScheduled: false });
    expect((calls[0][0] as { reason: string }).reason).toContain("read 0 files before editing");
  });

  it("claim-vs-diff drift with ineligible retry escalates with gate:'claim'", async () => {
    seedRequireCache({
      verifier: {
        runVerifier: async () => ({
          verdict: "drift",
          reason: "claimed files never touched",
          claimedFiles: ["a.ts"],
          actualFiles: [],
          unmatchedClaims: ["a.ts"],
          unclaimedActual: [],
          durationMs: 1,
        }),
      },
    });
    const calls = await driveExit();
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toMatchObject({ gate: "claim", retryScheduled: false });
    expect((calls[0][0] as { reason: string }).reason).toContain("claimed files never touched");
  });

  it("style-critic alien with ineligible retry escalates with gate:'style'", async () => {
    seedRequireCache({
      styleCritic: {
        runStyleCritic: async () => ({
          verdict: "alien",
          reason: "raw fetch instead of api client",
          issues: [],
          durationMs: 1,
        }),
      },
    });
    const calls = await driveExit({ quality: { critic: true, verifier: false } });
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toMatchObject({ gate: "style", retryScheduled: false });
    expect((calls[0][0] as { reason: string }).reason).toContain("raw fetch instead of api client");
  });

  it("semantic-verifier broken with ineligible retry escalates with gate:'semantic'", async () => {
    seedRequireCache({
      semanticVerifier: {
        runSemanticVerifier: async () => ({
          verdict: "broken",
          reason: "does not implement the task body",
          concerns: [],
          durationMs: 1,
        }),
      },
    });
    const calls = await driveExit({ quality: { critic: false, verifier: true } });
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toMatchObject({ gate: "semantic", retryScheduled: false });
    expect((calls[0][0] as { reason: string }).reason).toContain("does not implement the task body");
  });

  it("does NOT escalate when the gate schedules a retry (retryScheduled branch)", async () => {
    const retryRun = {
      sessionId: "99999999-9999-9999-9999-999999999999",
      role: "coder-vretry",
      repo: "real-app",
      status: "running",
      startedAt: null,
      endedAt: null,
    };
    seedRequireCache({
      verifyChain: {
        verifyConfigOf: () => ({ test: "x" }),
        hasAnyVerifyCommand: () => true,
        runVerifyChain: async () => ({
          steps: [{ name: "test", ok: false, exitCode: 1, durationMs: 1, output: "" }],
          passed: false,
          startedAt: "2026-04-24T10:00:02Z",
          endedAt: "2026-04-24T10:00:03Z",
        }),
        isEligibleForVerifyRetry: () => true,
        spawnVerifyRetry: async () => ({ sessionId: retryRun.sessionId, run: retryRun }),
      },
    });
    const calls = await driveExit();
    expect(calls).toHaveLength(0);
  });

  it("gates that pass do not escalate (clean proceed path)", async () => {
    const calls = await driveExit();
    expect(calls).toHaveLength(0);
  });

  it("preflight crash blocks the commit and escalates", async () => {
    seedRequireCache({
      preflightCheck: {
        runPreflight: () => { throw new Error("boom"); },
      },
    });
    const gitOps = await import("../gitOps");
    vi.mocked(gitOps.autoCommitAndPush).mockClear();

    const calls = await driveExit({ git: { ...REAL_APP.git, autoCommit: true } });

    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toMatchObject({ gate: "preflight", retryScheduled: false });
    expect((calls[0][0] as { reason: string }).reason).toContain("crashed");
    expect(gitOps.autoCommitAndPush).not.toHaveBeenCalled();

    const { readMeta } = await import("../meta");
    const meta = readMeta(tmp);
    const run = meta?.runs.find((r) => r.sessionId === SID);
    expect(run?.verifier?.verdict).toBe("crashed");
  });

  it("claim crash blocks the commit and escalates", async () => {
    seedRequireCache({
      verifier: {
        runVerifier: async () => { throw new Error("boom"); },
      },
    });
    const gitOps = await import("../gitOps");
    vi.mocked(gitOps.autoCommitAndPush).mockClear();

    const calls = await driveExit({ git: { ...REAL_APP.git, autoCommit: true } });

    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toMatchObject({ gate: "claim", retryScheduled: false });
    expect((calls[0][0] as { reason: string }).reason).toContain("crashed");
    expect(gitOps.autoCommitAndPush).not.toHaveBeenCalled();
  });

  it("style crash blocks the commit and escalates", async () => {
    seedRequireCache({
      styleCritic: {
        runStyleCritic: async () => { throw new Error("boom"); },
      },
    });
    const gitOps = await import("../gitOps");
    vi.mocked(gitOps.autoCommitAndPush).mockClear();

    const calls = await driveExit({
      git: { ...REAL_APP.git, autoCommit: true },
      quality: { critic: true, verifier: false },
    });

    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toMatchObject({ gate: "style", retryScheduled: false });
    expect((calls[0][0] as { reason: string }).reason).toContain("crashed");
    expect(gitOps.autoCommitAndPush).not.toHaveBeenCalled();
  });

  it("semantic crash blocks the commit and escalates", async () => {
    seedRequireCache({
      semanticVerifier: {
        runSemanticVerifier: async () => { throw new Error("boom"); },
      },
    });
    const gitOps = await import("../gitOps");
    vi.mocked(gitOps.autoCommitAndPush).mockClear();

    const calls = await driveExit({
      git: { ...REAL_APP.git, autoCommit: true },
      quality: { critic: false, verifier: true },
    });

    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toMatchObject({ gate: "semantic", retryScheduled: false });
    expect((calls[0][0] as { reason: string }).reason).toContain("crashed");
    expect(gitOps.autoCommitAndPush).not.toHaveBeenCalled();
  });

  it("records an explicit crashed verdict so the score can see it (semantic)", async () => {
    seedRequireCache({
      semanticVerifier: {
        runSemanticVerifier: async () => { throw new Error("panel exploded"); },
      },
    });
    await driveExit({ quality: { critic: false, verifier: true } });

    const { readMeta } = await import("../meta");
    const meta = readMeta(tmp);
    const run = meta?.runs.find((r) => r.sessionId === SID);
    expect(run?.semanticVerifier?.verdict).toBe("crashed");
  });
});

describe("postExitFlow — automatic worktree merge-back call site acts on failure (Task 25)", () => {
  const REAL_APP = {
    name: "real-app",
    path: "/tmp/fake-app",
    git: { branchMode: "current", worktreeMode: "auto", autoCommit: false, autoPush: false, mergeTargetBranch: "", integrationMode: "none" },
    verify: {},
    quality: { critic: false, verifier: false },
    retry: {},
    memory: { distill: false },
  };

  async function driveWorktreeExit() {
    const { createMeta, appendRun } = await import("../meta");
    const worktrees = await import("../worktrees");
    const ge = await import("../gateEscalation");
    const gitOps = await import("../gitOps");
    const { wireRunLifecycle } = await import("../runLifecycle");
    vi.mocked(ge.escalateGateBlock).mockClear();
    vi.mocked(gitOps.autoCommitAndPush).mockResolvedValue({ ok: true, message: "committed" });

    createMeta(tmp, TASK_HEADER);
    await appendRun(tmp, {
      sessionId: SID,
      role: "coder",
      repo: "real-app",
      status: "running",
      startedAt: "2026-04-24T10:00:01Z",
      endedAt: null,
      parentSessionId: "00000000-0000-0000-0000-000000000000",
      worktreePath: "/tmp/fake-app/.worktrees/sid",
      worktreeBranch: "claude/wt/x",
      worktreeBaseBranch: "main",
    });
    getAppMock.mockReturnValue(REAL_APP);

    const child = makeFakeChild();
    wireRunLifecycle(tmp, SID, child, "real-app", "tag");
    child.emit("exit", 0, null);
    await flushAsync(10);

    return { escalateCalls: vi.mocked(ge.escalateGateBlock).mock.calls, worktrees };
  }

  it("stamps the run and escalates when the automatic merge-back conflicts at the merge stage", async () => {
    const { worktrees } = await (async () => {
      const w = await import("../worktrees");
      vi.mocked(w.mergeAndRemoveWorktree).mockResolvedValue({
        ok: false,
        message: "merge of claude/wt/x into main failed (aborted; worktree kept at /tmp/fake-app/.worktrees/sid)",
        error: "CONFLICT (content): Merge conflict in foo.ts",
      });
      return { worktrees: w };
    })();

    const { escalateCalls } = await driveWorktreeExit();

    const { readMeta } = await import("../meta");
    const meta = readMeta(tmp);
    const run = meta?.runs.find((r) => r.sessionId === SID);
    expect(run?.mergeNotPushed).toBeTruthy();
    expect(run?.mergeNotPushed?.message).toContain("MERGE-CONFLICT:");

    expect(escalateCalls).toHaveLength(1);
    expect(escalateCalls[0][0]).toMatchObject({
      taskId: basename(tmp),
      sessionsDir: tmp,
      gate: "merge",
      retryScheduled: false,
    });

    expect(vi.mocked(worktrees.mergeAndRemoveWorktree)).toHaveBeenCalledTimes(1);
  });

  it("does NOT stamp or escalate when the automatic merge-back succeeds", async () => {
    const w = await import("../worktrees");
    vi.mocked(w.mergeAndRemoveWorktree).mockResolvedValue({
      ok: true,
      message: "merged claude/wt/x into main; removed worktree",
    });

    const { escalateCalls } = await driveWorktreeExit();

    const { readMeta } = await import("../meta");
    const meta = readMeta(tmp);
    const run = meta?.runs.find((r) => r.sessionId === SID);
    expect(run?.mergeNotPushed ?? null).toBeNull();
    expect(escalateCalls).toHaveLength(0);
  });
});

describe("wireRunLifecycle — repo reservation release (Task 16)", () => {
  const REAL_APP = {
    name: "real-app",
    path: "/tmp/fake-app",
    git: { branchMode: "current", worktreeMode: "disabled", autoCommit: false, autoPush: false, mergeTargetBranch: "", integrationMode: "none" },
    verify: {},
    quality: { critic: false, verifier: false },
    retry: {},
    memory: { distill: false },
  };

  it("releases the app reservation once failRun completes", async () => {
    const { createMeta, appendRun } = await import("../meta");
    const { wireRunLifecycle } = await import("../runLifecycle");
    const { acquireRepoReservation, currentReservation } = await import("../repoReservation");

    createMeta(tmp, TASK_HEADER);
    await appendRun(tmp, {
      sessionId: SID,
      role: "coder",
      repo: "real-app",
      status: "running",
      startedAt: "2026-04-24T10:00:01Z",
      endedAt: null,
    });
    acquireRepoReservation("real-app", SID);

    const child = makeFakeChild();
    wireRunLifecycle(tmp, SID, child, "real-app", "tag");
    child.emit("exit", 1, null);
    await flushAsync();

    expect(currentReservation("real-app")).toBeNull();
  });

  it("releases the app reservation on the spawn-error path (child.error)", async () => {
    const { createMeta, appendRun } = await import("../meta");
    const { wireRunLifecycle } = await import("../runLifecycle");
    const { acquireRepoReservation, currentReservation } = await import("../repoReservation");

    createMeta(tmp, TASK_HEADER);
    await appendRun(tmp, {
      sessionId: SID,
      role: "coder",
      repo: "real-app",
      status: "running",
      startedAt: null,
      endedAt: null,
    });
    acquireRepoReservation("real-app", SID);

    const child = makeFakeChild();
    wireRunLifecycle(tmp, SID, child, "real-app", "tag");
    child.emit("error", new Error("ENOENT"));
    await flushAsync();

    expect(currentReservation("real-app")).toBeNull();
  });

  it("holds the reservation while postExitFlow's async gate work is still pending, and releases once it settles", async () => {
    const { createMeta, appendRun } = await import("../meta");
    const { wireRunLifecycle } = await import("../runLifecycle");
    const { acquireRepoReservation, currentReservation } = await import("../repoReservation");

    let resolveVerify: (v: unknown) => void = () => {};
    const verifyPromise = new Promise((resolve) => { resolveVerify = resolve; });
    seedRequireCache({
      verifyChain: {
        verifyConfigOf: () => ({ test: "x" }),
        hasAnyVerifyCommand: () => true,
        runVerifyChain: () => verifyPromise,
      },
    });

    createMeta(tmp, TASK_HEADER);
    await appendRun(tmp, {
      sessionId: SID,
      role: "coder",
      repo: "real-app",
      status: "running",
      startedAt: "2026-04-24T10:00:01Z",
      endedAt: null,
      parentSessionId: "00000000-0000-0000-0000-000000000000",
    });
    getAppMock.mockReturnValue(REAL_APP);
    acquireRepoReservation("real-app", SID);

    const child = makeFakeChild();
    wireRunLifecycle(tmp, SID, child, "real-app", "tag");
    child.emit("exit", 0, null);
    await flushAsync(5);

    expect(currentReservation("real-app")?.sessionId).toBe(SID);

    resolveVerify({
      steps: [{ name: "test", ok: true, exitCode: 0, durationMs: 1, output: "" }],
      passed: true,
      startedAt: "2026-04-24T10:00:02Z",
      endedAt: "2026-04-24T10:00:03Z",
    });
    await flushAsync(10);

    expect(currentReservation("real-app")).toBeNull();
  });

  it("does not disturb a different session's reservation on the same repo", async () => {
    const { createMeta, appendRun } = await import("../meta");
    const { wireRunLifecycle } = await import("../runLifecycle");
    const { acquireRepoReservation, currentReservation, releaseRepoReservation } =
      await import("../repoReservation");

    releaseRepoReservation("real-app", "someone-else");
    createMeta(tmp, TASK_HEADER);
    await appendRun(tmp, {
      sessionId: SID,
      role: "coder",
      repo: "real-app",
      status: "running",
      startedAt: "2026-04-24T10:00:01Z",
      endedAt: null,
    });
    acquireRepoReservation("real-app", "someone-else");

    const child = makeFakeChild();
    wireRunLifecycle(tmp, SID, child, "real-app", "tag");
    child.emit("exit", 1, null);
    await flushAsync();

    expect(currentReservation("real-app")?.sessionId).toBe("someone-else");
    releaseRepoReservation("real-app", "someone-else");
  });

  it("releases using the wire-time repo even when the task's meta directory is already gone (Critical 1 — task deletion)", async () => {
    const { createMeta, appendRun } = await import("../meta");
    const { wireRunLifecycle } = await import("../runLifecycle");
    const { acquireRepoReservation, currentReservation } = await import("../repoReservation");

    createMeta(tmp, TASK_HEADER);
    await appendRun(tmp, {
      sessionId: SID,
      role: "coder",
      repo: "real-app",
      status: "running",
      startedAt: "2026-04-24T10:00:01Z",
      endedAt: null,
    });
    acquireRepoReservation("real-app", SID);

    const child = makeFakeChild();
    wireRunLifecycle(tmp, SID, child, "real-app", "tag");

    const { rmSync } = await import("node:fs");
    rmSync(tmp, { recursive: true, force: true });

    child.emit("exit", 1, null);
    await flushAsync();

    expect(currentReservation("real-app")).toBeNull();
  });

  it("releases immediately for a coordinator-role run (postExitFlow never runs for coordinators)", async () => {
    const { createMeta, appendRun } = await import("../meta");
    const { wireRunLifecycle } = await import("../runLifecycle");
    const { acquireRepoReservation, currentReservation } = await import("../repoReservation");

    createMeta(tmp, TASK_HEADER);
    await appendRun(tmp, {
      sessionId: SID,
      role: "coordinator",
      repo: "real-app",
      status: "running",
      startedAt: "2026-04-24T10:00:01Z",
      endedAt: null,
    });
    getAppMock.mockReturnValue(REAL_APP);
    acquireRepoReservation("real-app", SID);

    const child = makeFakeChild();
    wireRunLifecycle(tmp, SID, child, "real-app", "tag");
    child.emit("exit", 0, null);
    await flushAsync(8);

    expect(currentReservation("real-app")).toBeNull();
  });

  it("releases when the run row can't be found at succeedRun time (meta lookup miss)", async () => {
    const { createMeta, appendRun } = await import("../meta");
    const { wireRunLifecycle } = await import("../runLifecycle");
    const { acquireRepoReservation, currentReservation } = await import("../repoReservation");

    createMeta(tmp, TASK_HEADER);
    await appendRun(tmp, {
      sessionId: "other-sid",
      role: "coder",
      repo: "other-repo",
      status: "running",
      startedAt: null,
      endedAt: null,
    });
    acquireRepoReservation("real-app", SID);

    const child = makeFakeChild();
    wireRunLifecycle(tmp, SID, child, "real-app", "tag");
    child.emit("exit", 0, null);
    await flushAsync();

    expect(currentReservation("real-app")).toBeNull();
  });

  it("keeps the reservation held when a gate schedules a same-session retry, and releases only once that retry's own run settles", async () => {
    const { createMeta, appendRun } = await import("../meta");
    const { wireRunLifecycle } = await import("../runLifecycle");
    const { acquireRepoReservation, currentReservation } = await import("../repoReservation");

    let verifyCallCount = 0;
    let retryChild: ReturnType<typeof makeFakeChild> | null = null;
    seedRequireCache({
      verifyChain: {
        verifyConfigOf: () => ({ test: "x" }),
        hasAnyVerifyCommand: () => true,
        runVerifyChain: async () => {
          verifyCallCount += 1;
          if (verifyCallCount === 1) {
            return {
              steps: [{ name: "test", ok: false, exitCode: 1, durationMs: 1, output: "" }],
              passed: false,
              startedAt: "2026-04-24T10:00:02Z",
              endedAt: "2026-04-24T10:00:03Z",
            };
          }
          return {
            steps: [{ name: "test", ok: true, exitCode: 0, durationMs: 1, output: "" }],
            passed: true,
            startedAt: "2026-04-24T10:01:02Z",
            endedAt: "2026-04-24T10:01:03Z",
          };
        },
        isEligibleForVerifyRetry: () => true,
        spawnVerifyRetry: async () => {
          retryChild = makeFakeChild();
          wireRunLifecycle(tmp, SID, retryChild, "real-app", "retry-tag");
          return {
            sessionId: SID,
            run: {
              sessionId: SID,
              role: "coder-vretry",
              repo: "real-app",
              status: "running",
              startedAt: null,
              endedAt: null,
            },
          };
        },
      },
    });

    createMeta(tmp, TASK_HEADER);
    await appendRun(tmp, {
      sessionId: SID,
      role: "coder",
      repo: "real-app",
      status: "running",
      startedAt: "2026-04-24T10:00:01Z",
      endedAt: null,
      parentSessionId: "00000000-0000-0000-0000-000000000000",
    });
    getAppMock.mockReturnValue(REAL_APP);
    acquireRepoReservation("real-app", SID);

    const child = makeFakeChild();
    wireRunLifecycle(tmp, SID, child, "real-app", "tag");
    child.emit("exit", 0, null);
    await flushAsync(15);

    expect(retryChild).not.toBeNull();
    expect(currentReservation("real-app")?.sessionId).toBe(SID);

    retryChild!.emit("exit", 0, null);
    await flushAsync(15);

    expect(currentReservation("real-app")).toBeNull();
  });
});
