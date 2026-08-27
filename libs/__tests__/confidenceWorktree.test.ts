import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve as resolvePath } from "node:path";
import type { ChildProcess } from "node:child_process";
import { shouldHoldOutward } from "../confidenceScore";
import {
  readConfidenceConfig,
  writeConfidenceConfig,
  _resetForTests,
  _internal,
} from "../confidenceConfig";
import type { App } from "../apps";


describe("shouldHoldOutward — holdWorktree opt-in (Task 7)", () => {
  it("holds a low-score worktree run when holdWorktree:true (brief Step 1, case 1)", () => {
    expect(
      shouldHoldOutward(50, { enabled: true, threshold: 70, holdWorktree: true }, true),
    ).toBe(true);
  });

  it("does NOT hold a low-score worktree run when holdWorktree:false (brief Step 1, case 2)", () => {
    expect(
      shouldHoldOutward(50, { enabled: true, threshold: 70, holdWorktree: false }, true),
    ).toBe(false);
  });

  it("does NOT hold a low-score worktree run when holdWorktree is absent (default = pre-Task-7 behavior)", () => {
    expect(shouldHoldOutward(50, { enabled: true, threshold: 70 }, true)).toBe(false);
  });

  it("holdWorktree has no effect on live-tree (non-worktree) runs — they already hold on score alone", () => {
    expect(
      shouldHoldOutward(50, { enabled: true, threshold: 70, holdWorktree: false }, false),
    ).toBe(true);
  });

  it("still never holds when disabled, even with holdWorktree:true", () => {
    expect(
      shouldHoldOutward(10, { enabled: false, threshold: 70, holdWorktree: true }, true),
    ).toBe(false);
  });

  it("still never holds at/above threshold, even with holdWorktree:true", () => {
    expect(
      shouldHoldOutward(70, { enabled: true, threshold: 70, holdWorktree: true }, true),
    ).toBe(false);
  });
});

describe("confidenceConfig — holdWorktree round-trip (brief Step 1, case 3)", () => {
  const { CONFIG_FILE } = _internal;
  let saved: string | null = null;

  beforeEach(() => {
    saved = existsSync(CONFIG_FILE) ? readFileSync(CONFIG_FILE, "utf8") : null;
    if (existsSync(CONFIG_FILE)) rmSync(CONFIG_FILE, { force: true });
    _resetForTests();
  });
  afterEach(() => {
    if (saved !== null) writeFileSync(CONFIG_FILE, saved, "utf8");
    else if (existsSync(CONFIG_FILE)) rmSync(CONFIG_FILE, { force: true });
    _resetForTests();
  });

  it("defaults holdWorktree to false", () => {
    expect(readConfidenceConfig().holdWorktree).toBe(false);
  });

  it("persists holdWorktree:true through write + in-memory read", () => {
    writeConfidenceConfig({ holdWorktree: true });
    expect(readConfidenceConfig()).toEqual({ enabled: true, threshold: 70, holdWorktree: true });
  });

  it("writes holdWorktree into the on-disk JSON file", () => {
    writeConfidenceConfig({ enabled: true, threshold: 55, holdWorktree: true });
    const onDisk = JSON.parse(readFileSync(CONFIG_FILE, "utf8"));
    expect(onDisk).toEqual({ enabled: true, threshold: 55, holdWorktree: true });
  });

  it("holdWorktree survives a patch that only touches other fields", () => {
    writeConfidenceConfig({ holdWorktree: true });
    writeConfidenceConfig({ threshold: 40 });
    expect(readConfidenceConfig()).toEqual({ enabled: true, threshold: 40, holdWorktree: true });
  });
});


const mergeAndRemoveWorktreeMock = vi.fn();
vi.mock("../worktrees", () => ({
  mergeAndRemoveWorktree: (...args: unknown[]) => mergeAndRemoveWorktreeMock(...args),
}));

const autoCommitAndPushMock = vi.fn();
const mergeIntoTargetBranchMock = vi.fn();
const readCurrentBranchMock = vi.fn();
vi.mock("../gitOps", () => ({
  autoCommitAndPush: (...args: unknown[]) => autoCommitAndPushMock(...args),
  mergeIntoTargetBranch: (...args: unknown[]) => mergeIntoTargetBranchMock(...args),
  readCurrentBranch: (...args: unknown[]) => readCurrentBranchMock(...args),
}));

const runDevopsAgentMock = vi.fn();
vi.mock("../devops", () => ({
  runDevopsAgent: (...args: unknown[]) => runDevopsAgentMock(...args),
}));

const REAL_APP: App = {
  name: "real-app",
  path: "/tmp/fake-app",
  rawPath: "real-app",
  description: "",
  git: {
    branchMode: "current",
    fixedBranch: "",
    autoCommit: false,
    autoPush: true,
    worktreeMode: "enabled",
    mergeTargetBranch: "release",
    integrationMode: "auto-merge",
  },
  verify: {},
  pinnedFiles: [],
  symbolDirs: [],
  quality: { critic: false, verifier: true },
  retry: {},
  memory: { distill: false },
  dispatch: {},
  capabilities: [],
};

describe("performWorktreeMergeBack", () => {
  let tmp: string;
  const SID = "22222222-3333-4444-5555-666666666666";

  beforeEach(() => {
    vi.resetModules();
    mergeAndRemoveWorktreeMock.mockReset();
    autoCommitAndPushMock.mockReset();
    mergeIntoTargetBranchMock.mockReset();
    runDevopsAgentMock.mockReset();
    tmp = mkdtempSync(join(tmpdir(), "confidence-worktree-"));
  });
  afterEach(() => {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { }
  });

  async function seedRun() {
    const { createMeta, appendRun } = await import("../meta");
    createMeta(tmp, {
      taskId: "t_20260710_001",
      taskTitle: "test task",
      taskBody: "test body",
      taskStatus: "doing",
      taskSection: "DOING",
      taskChecked: false,
      createdAt: "2026-07-10T10:00:00Z",
    });
    await appendRun(tmp, {
      sessionId: SID,
      role: "coder",
      repo: "real-app",
      status: "done",
      startedAt: "2026-07-10T10:00:01Z",
      endedAt: "2026-07-10T10:00:02Z",
      worktreePath: "/tmp/fake-app/.worktrees/" + SID,
      worktreeBranch: "claude/wt/t_20260710_001-2222",
      worktreeBaseBranch: "main",
    });
    const { readMeta } = await import("../meta");
    const meta = readMeta(tmp);
    return meta!.runs.find((r) => r.sessionId === SID)!;
  }

  it("merges, runs worktree-mode integration, pushes the live tree, and reports ok:true", async () => {
    const { performWorktreeMergeBack } = await import("../runLifecycle");
    const run = await seedRun();

    mergeAndRemoveWorktreeMock.mockResolvedValue({ ok: true, message: "merged wt into base; removed" });
    mergeIntoTargetBranchMock.mockResolvedValue({ ok: true, message: "merged into release" });
    autoCommitAndPushMock.mockResolvedValue({ ok: true, message: "pushed" });

    const result = await performWorktreeMergeBack({
      app: REAL_APP,
      run,
      tid: "t_20260710_001",
      title: "test task",
      t: "test-tag",
      dir: tmp,
      message: "[t_20260710_001] test task",
    });

    expect(result.ok).toBe(true);
    expect(mergeAndRemoveWorktreeMock).toHaveBeenCalledWith({
      appPath: "/tmp/fake-app",
      handle: { path: run.worktreePath, branch: run.worktreeBranch, baseBranch: run.worktreeBaseBranch },
    });
    expect(mergeIntoTargetBranchMock).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: "/tmp/fake-app", sourceBranch: "main", targetBranch: "release", push: false }),
    );
    expect(autoCommitAndPushMock).toHaveBeenCalledTimes(1);
    expect(autoCommitAndPushMock).toHaveBeenCalledWith(
      "/tmp/fake-app",
      expect.objectContaining({ autoCommit: false, autoPush: true }),
      "[t_20260710_001] test task",
    );
  });

  it("reports {ok:false, stage:'merge'} and skips integration + push when the worktree merge fails", async () => {
    const { performWorktreeMergeBack } = await import("../runLifecycle");
    const run = await seedRun();

    mergeAndRemoveWorktreeMock.mockResolvedValue({ ok: false, message: "merge conflict", error: "CONFLICT" });

    const result = await performWorktreeMergeBack({
      app: REAL_APP,
      run,
      tid: "t_20260710_001",
      title: "test task",
      t: "test-tag",
      dir: tmp,
      message: "[t_20260710_001] test task",
    });

    expect(result.ok).toBe(false);
    expect(result.stage).toBe("merge");
    expect(result.detail).toContain("merge conflict");
    expect(mergeIntoTargetBranchMock).not.toHaveBeenCalled();
    expect(autoCommitAndPushMock).not.toHaveBeenCalled();
  });

  it("reports {ok:false, stage:'merge'} when mergeAndRemoveWorktree itself throws (crash path, never rethrows)", async () => {
    const { performWorktreeMergeBack } = await import("../runLifecycle");
    const run = await seedRun();

    mergeAndRemoveWorktreeMock.mockRejectedValue(new Error("git exploded"));

    const result = await performWorktreeMergeBack({
      app: REAL_APP,
      run,
      tid: "t_20260710_001",
      title: "test task",
      t: "test-tag",
      dir: tmp,
      message: "[t_20260710_001] test task",
    });

    expect(result.ok).toBe(false);
    expect(result.stage).toBe("merge");
    expect(result.detail).toContain("git exploded");
  });

  it("reports {ok:false, stage:'push'} + stamps mergeNotPushed when the merge lands but the live-tree push fails", async () => {
    const { performWorktreeMergeBack } = await import("../runLifecycle");
    const { readMeta } = await import("../meta");
    const run = await seedRun();

    mergeAndRemoveWorktreeMock.mockResolvedValue({ ok: true, message: "merged wt into base; removed" });
    autoCommitAndPushMock.mockResolvedValue({ ok: false, message: "push failed", error: "auth error" });

    const result = await performWorktreeMergeBack({
      app: { ...REAL_APP, git: { ...REAL_APP.git, integrationMode: "none" as const, mergeTargetBranch: "" } },
      run,
      tid: "t_20260710_001",
      title: "test task",
      t: "test-tag",
      dir: tmp,
      message: "[t_20260710_001] test task",
    });

    expect(result.ok).toBe(false);
    expect(result.stage).toBe("push");
    const updated = readMeta(tmp)?.runs.find((r) => r.sessionId === SID);
    expect(updated?.mergeNotPushed?.message).toContain("MERGE-NO-PUSH:");
    expect(updated?.mergeNotPushed?.error).toBe("auth error");
  });

  it("reports {ok:false, stage:'integration'} when the merge lands but integration fails (push still runs)", async () => {
    const { performWorktreeMergeBack } = await import("../runLifecycle");
    const run = await seedRun();

    mergeAndRemoveWorktreeMock.mockResolvedValue({ ok: true, message: "merged wt into base; removed" });
    mergeIntoTargetBranchMock.mockResolvedValue({ ok: false, message: "target merge conflict", error: "CONFLICT" });
    autoCommitAndPushMock.mockResolvedValue({ ok: true, message: "pushed" });

    const result = await performWorktreeMergeBack({
      app: REAL_APP,
      run,
      tid: "t_20260710_001",
      title: "test task",
      t: "test-tag",
      dir: tmp,
      message: "[t_20260710_001] test task",
    });

    expect(result.ok).toBe(false);
    expect(result.stage).toBe("integration");
    expect(result.detail).toContain("target merge conflict");
    expect(autoCommitAndPushMock).toHaveBeenCalledTimes(1);
  });

  it("is a no-op (ok:true) when the run has no worktreePath (defensive guard)", async () => {
    const { performWorktreeMergeBack } = await import("../runLifecycle");
    const run = await seedRun();

    const result = await performWorktreeMergeBack({
      app: REAL_APP,
      run: { ...run, worktreePath: null },
      tid: "t_20260710_001",
      title: "test task",
      t: "test-tag",
      dir: tmp,
      message: "[t_20260710_001] test task",
    });

    expect(result.ok).toBe(true);
    expect(mergeAndRemoveWorktreeMock).not.toHaveBeenCalled();
  });
});


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
      claimSpeculativeWinner: async () => ({ proceed: true, outcome: "n/a", reason: "test", killed: [] }),
    },
    memoryDistill: {
      runMemoryDistill: async () => ({ appended: 0, reason: "test", distillSessionId: null }),
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

const getAppMock = vi.fn();
vi.mock("../apps", () => ({
  getApp: (name: string) => getAppMock(name),
  loadApps: () => [],
  isValidAppName: () => true,
  semanticVerifierEnabled: (app: { quality?: { verifier?: boolean } }) => app.quality?.verifier !== false,
  resolvePanelSize: () => 3,
}));

vi.mock("../gateEscalation", () => ({
  escalateGateBlock: vi.fn(),
  notifyGateInfraSkip: vi.fn(),
}));

function makeFakeChild(): ChildProcess & { emit: (ev: string, ...args: unknown[]) => boolean } {
  const ee = new EventEmitter();
  return ee as unknown as ChildProcess & { emit: (ev: string, ...args: unknown[]) => boolean };
}
async function flushAsync(times = 10): Promise<void> {
  for (let i = 0; i < times; i++) {
    await new Promise((r) => setImmediate(r));
  }
}

describe("postExitFlow — worktree confidence hold wiring", () => {
  let tmp: string;
  const SID = "33333333-4444-5555-6666-777777777777";
  const TASK_HEADER = {
    taskId: "t_20260710_002",
    taskTitle: "test task",
    taskBody: "test body",
    taskStatus: "doing" as const,
    taskSection: "DOING" as const,
    taskChecked: false,
    createdAt: "2026-07-10T10:00:00Z",
  };

  const { CONFIG_FILE } = _internal;
  let savedConfig: string | null = null;

  beforeEach(() => {
    vi.resetModules();
    mergeAndRemoveWorktreeMock.mockReset().mockResolvedValue({ ok: true, message: "merged wt into base; removed" });
    autoCommitAndPushMock.mockReset().mockResolvedValue({ ok: true, message: "ok" });
    mergeIntoTargetBranchMock.mockReset().mockResolvedValue({ ok: true, message: "merged into release" });
    runDevopsAgentMock.mockReset();
    getAppMock.mockReset();
    tmp = mkdtempSync(join(tmpdir(), "confidence-worktree-flow-"));
    seedRequireCache({
      verifier: {
        runVerifier: async () => ({
          verdict: "pass",
          reason: "",
          claimedFiles: [],
          actualFiles: [],
          unmatchedClaims: ["a", "b", "c", "d", "e"],
          unclaimedActual: [],
          durationMs: 1,
        }),
      },
      semanticVerifier: {
        runSemanticVerifier: async () => ({
          verdict: "drift",
          reason: "",
          concerns: [],
          durationMs: 1,
          panelSize: 3,
          votes: [
            { lens: "correctness", verdict: "pass", reason: "" },
            { lens: "edge-cases", verdict: "drift", reason: "" },
            { lens: "regression", verdict: "pass", reason: "" },
          ],
        }),
      },
    });
    savedConfig = existsSync(CONFIG_FILE) ? readFileSync(CONFIG_FILE, "utf8") : null;
    if (existsSync(CONFIG_FILE)) rmSync(CONFIG_FILE, { force: true });
    _resetForTests();
  });
  afterEach(() => {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { }
    Module._resolveFilename = originalResolve;
    if (savedConfig !== null) writeFileSync(CONFIG_FILE, savedConfig, "utf8");
    else if (existsSync(CONFIG_FILE)) rmSync(CONFIG_FILE, { force: true });
    _resetForTests();
  });

  async function driveExit(appGitOverrides: object) {
    const { createMeta, appendRun, readMeta } = await import("../meta");
    const { wireRunLifecycle } = await import("../runLifecycle");

    createMeta(tmp, TASK_HEADER);
    await appendRun(tmp, {
      sessionId: SID,
      role: "coder",
      repo: "real-app",
      status: "running",
      startedAt: "2026-07-10T10:00:01Z",
      endedAt: null,
      worktreePath: "/tmp/fake-app/.worktrees/" + SID,
      worktreeBranch: "claude/wt/t_20260710_002-3333",
      worktreeBaseBranch: "main",
    });
    getAppMock.mockReturnValue({
      name: "real-app",
      path: "/tmp/fake-app",
      git: {
        branchMode: "current",
        fixedBranch: "",
        autoCommit: false,
        autoPush: true,
        worktreeMode: "enabled",
        mergeTargetBranch: "release",
        integrationMode: "auto-merge",
        ...appGitOverrides,
      },
      verify: {},
      quality: { critic: false, verifier: true },
      retry: {},
      memory: { distill: false },
    });

    const child = makeFakeChild();
    wireRunLifecycle(tmp, SID, child, "real-app", "tag");
    child.emit("exit", 0, null);
    await flushAsync(12);

    return readMeta(tmp)?.runs.find((r) => r.sessionId === SID);
  }

  it("holdWorktree:true + low score → defers merge-back, stamps heldAt, keeps the worktree path on the run", async () => {
    const { writeConfidenceConfig } = await import("../confidenceConfig");
    writeConfidenceConfig({ enabled: true, threshold: 70, holdWorktree: true });

    const run = await driveExit({});

    expect(mergeAndRemoveWorktreeMock).not.toHaveBeenCalled();
    expect(mergeIntoTargetBranchMock).not.toHaveBeenCalled();
    expect(run?.confidence?.heldAt).toBeTruthy();
    expect(run?.confidence?.reviewedBy ?? null).toBeNull();
    expect(run?.confidence?.score).toBeLessThan(70);
    expect(run?.worktreePath).toBe("/tmp/fake-app/.worktrees/" + SID);
    expect(run?.status).toBe("done");
  });

  it("holdWorktree:false (default) + low score → still merges back immediately (pre-Task-7 regression)", async () => {
    const { writeConfidenceConfig } = await import("../confidenceConfig");
    writeConfidenceConfig({ enabled: true, threshold: 70, holdWorktree: false });

    const run = await driveExit({});

    expect(mergeAndRemoveWorktreeMock).toHaveBeenCalledTimes(1);
    expect(run?.confidence?.heldAt ?? null).toBeNull();
    expect(run?.confidence?.score).toBeLessThan(70);
  });

  it("holdWorktree absent (config default) + low score → still merges back immediately", async () => {
    const run = await driveExit({});

    expect(mergeAndRemoveWorktreeMock).toHaveBeenCalledTimes(1);
    expect(run?.confidence?.heldAt ?? null).toBeNull();
  });
});
