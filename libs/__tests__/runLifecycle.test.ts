import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve as resolvePath } from "node:path";
import type { ChildProcess } from "node:child_process";

/**
 * runLifecycle.ts uses lazy `require("./<gate>")` inside the post-exit
 * flow to break a circular import. vitest's `vi.mock` only catches
 * static `import` statements, not `require()` — so we have to seed
 * `require.cache` on the *source* require's resolution before the
 * subject module loads. Each fake module exposes the same shape as
 * the real one but every function returns a benign no-op so the post-
 * exit pipeline short-circuits to "no gate ran".
 */
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

function seedRequireCache() {
  const libsDir = resolvePath(__dirname, "..");
  const fakes: Record<string, unknown> = {
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
  // Hook Node's CJS resolver so a `require("./<gate>")` call inside
  // runLifecycle.ts (which is a .ts file with no compiled .js sibling
  // on disk) gets steered at our seeded cache entry instead of failing
  // with MODULE_NOT_FOUND. Vitest's mock registry only catches static
  // `import`s, not lazy `require`, so this override is the only way
  // to mock the post-exit gate modules.
  const fakeKeyFor: Record<string, string> = {};
  for (const [name, mod] of Object.entries(fakes)) {
    const filename = resolvePath(libsDir, name + ".ts");
    fakeKeyFor[name] = filename;
    Module._cache[filename] = {
      id: filename,
      filename,
      loaded: true,
      exports: mod,
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

/**
 * `wireRunLifecycle` is the bridge's "child exit → meta.json status
 * flip" hook. Three state-transition guards keep it from corrupting
 * a run record under race:
 *
 *   1. `succeedRun` defers the running → done flip when a post-exit
 *      gate (verify chain, verifier, style critic, semantic verifier)
 *      will run for this app. The gate's `attachGateResult` collapses
 *      status:done + the result into a single combined patch, so a
 *      racing writer can't slip in between.
 *   2. `failRun` runs the patch under a precondition that the row is
 *      still `running`. A late `exit` after a post-exit gate already
 *      wrote `done` must NOT demote it back to `failed`.
 *   3. The kill-route's own status patch runs the same precondition;
 *      a post-exit `running → done` flip after a kill-mediated
 *      `failed` must not undo the explicit failure.
 *
 * These tests exercise the public `wireRunLifecycle` entry point with
 * a `vi.mock`'d gate layer so we never spawn a real `claude`. The fake
 * child is just a Node `EventEmitter` — `wireRunLifecycle` only attaches
 * `on("error" | "exit", …)` listeners.
 */

// All gate modules return null/false so post-exit flow short-circuits
// to the "no gate ran" branch in succeedRun's outer guard. The guard
// behavior (deferred flip when a gate WILL run) is exercised separately
// via the `getApp` mock — when an app is registered for a non-coordinator
// run, the flip is deferred regardless of whether the gate ultimately
// produces a result.
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

// Auto-retry hook: never kicks in. Without this the failRun branch
// would call into childRetry which has its own I/O.
vi.mock("../childRetry", () => ({
  maybeScheduleRetry: vi.fn(),
}));

// Permission settings cleanup is fire-and-forget in setImmediate; mock
// to a no-op so the test doesn't try to touch a real on-disk dir.
vi.mock("../permissionSettings", () => ({
  cleanupSessionSettings: vi.fn(),
}));

// The default test path returns null (no app registered) so the post-
// exit flow falls through to the `if (!app)` safety-net branch — that's
// the simplest path to exercise. Individual tests can re-mock with
// `getApp.mockReturnValueOnce(...)` for the deferred-flip case.
const getAppMock = vi.fn();
vi.mock("../apps", () => ({
  getApp: (name: string) => getAppMock(name),
  // postExitFlow → repos.appsAsRepos pulls the full app list when the
  // run isn't in a worktree. Empty array keeps that path inert.
  loadApps: () => [],
  isValidAppName: () => true,
}));

// `readBridgeMd` returning "" short-circuits resolveRepoCwd (which
// would otherwise call into the full repos pipeline). Same trick we
// use everywhere else when we don't care about repo resolution in a
// test.
vi.mock("../paths", async () => {
  const actual = await vi.importActual<typeof import("../paths")>("../paths");
  return {
    ...actual,
    readBridgeMd: () => "",
  };
});

// gitOps / worktrees / devops side-effects: stub everything to no-ops.
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
  // Reset the per-call mock so each test owns its own getApp behavior.
  getAppMock.mockReset();
  getAppMock.mockReturnValue(null);
  seedRequireCache();
});

afterEach(() => {
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  Module._resolveFilename = originalResolve;
});

/** Spin up a fake `claude` child that's just an EventEmitter. */
function makeFakeChild(): ChildProcess & { emit: (ev: string, ...args: unknown[]) => boolean } {
  const ee = new EventEmitter();
  return ee as unknown as ChildProcess & { emit: (ev: string, ...args: unknown[]) => boolean };
}

/**
 * `wireRunLifecycle` works asynchronously inside `void succeedRun()` /
 * `void failRun()` — give the microtask queue + setImmediate cleanup a
 * couple of ticks to drain before reading meta.json.
 */
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
    wireRunLifecycle(tmp, SID, child, "test-coordinator");
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
    wireRunLifecycle(tmp, SID, child, "test-coordinator");
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
    wireRunLifecycle(tmp, SID, child, "test-signal-kill");
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
    // Simulate a gate (or anything else) writing `done` BEFORE the
    // child's exit event fires — succeedRun must observe the row as
    // already-done and not re-flip it.
    await updateRun(tmp, SID, { status: "done", endedAt: "2026-04-24T10:00:02Z" });

    const child = makeFakeChild();
    wireRunLifecycle(tmp, SID, child, "tag");
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
    // Simulate the kill route flipping the row to `failed` first; the
    // child's exit handler must respect that final state and not
    // overwrite it (e.g. with a different `endedAt` or status).
    await updateRun(tmp, SID, {
      status: "failed",
      endedAt: "2026-04-24T10:00:02Z",
    });

    const child = makeFakeChild();
    wireRunLifecycle(tmp, SID, child, "tag");
    child.emit("exit", 137, null);
    await flushAsync();

    const meta = readMeta(tmp);
    const run = meta?.runs.find((r) => r.sessionId === SID);
    expect(run?.status).toBe("failed");
    // endedAt must be the kill-time value — failRun's precondition
    // means it never wrote a second timestamp.
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
    wireRunLifecycle(tmp, SID, child, "tag");
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

    // Register an app for `real-app`. With a non-coordinator role this
    // is the trigger for `willRunPostExitGate = true` — succeedRun must
    // NOT flip the run to `done` itself; it defers to the gate's
    // `attachGateResult` (which our test mocks short-circuit, leaving
    // the run in `running`). The downstream "no-app" safety net would
    // pick it up if app were null, but here the gate path owns the flip.
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
    wireRunLifecycle(tmp, SID, child, "tag");
    child.emit("exit", 0, null);
    await flushAsync(8);

    const meta = readMeta(tmp);
    const run = meta?.runs.find((r) => r.sessionId === SID);
    // The flip is deferred: gate would write done+result atomically.
    // Our gate stubs all return null, so post-exit's safety net for
    // app-less runs (`if (!app)`) is also skipped. End result: status
    // stays `running` for this test, which proves the deferral happened.
    expect(run?.status).toBe("running");
    expect(run?.endedAt).toBeNull();
  });

  it("does not write to a non-existent run (lookup miss) — meta stays untouched", async () => {
    const { createMeta, appendRun, readMeta } = await import("../meta");
    const { wireRunLifecycle } = await import("../runLifecycle");

    createMeta(tmp, TASK_HEADER);
    // Append a DIFFERENT run; the wired session id below has no row.
    await appendRun(tmp, {
      sessionId: "other-sid",
      role: "coordinator",
      repo: "fake-repo",
      status: "running",
      startedAt: null,
      endedAt: null,
    });

    const child = makeFakeChild();
    wireRunLifecycle(tmp, SID, child, "tag");
    child.emit("exit", 0, null);
    await flushAsync();

    const meta = readMeta(tmp);
    // The unrelated row stays exactly as it was.
    const other = meta?.runs.find((r) => r.sessionId === "other-sid");
    expect(other?.status).toBe("running");
    // The wired (missing) sid produced no row.
    expect(meta?.runs.find((r) => r.sessionId === SID)).toBeUndefined();
  });
});
