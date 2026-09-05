import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { rmSync } from "node:fs";
import { join } from "node:path";
import type { ChildProcess } from "node:child_process";

const TMP_SESSIONS = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { mkdtempSync } = require("node:fs") as typeof import("node:fs");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { tmpdir } = require("node:os") as typeof import("node:os");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { join } = require("node:path") as typeof import("node:path");
  return mkdtempSync(join(tmpdir(), "bridge-agents-model-"));
});

vi.mock("../paths", async () => {
  const actual = await vi.importActual<typeof import("../paths")>("../paths");
  return { ...actual, SESSIONS_DIR: TMP_SESSIONS };
});

vi.mock("../auth", () => ({ verifyRequestActor: () => null }));

vi.mock("../detect", () => ({
  getOrComputeScope: async () => ({
    source: "heuristic",
    confidence: "high",
    reason: "test",
    repos: [{ name: "fake-model-app", score: 1, reason: "test" }],
    features: [],
    entities: [],
    files: [],
  }),
  loadDetectInput: () => ({ taskBody: "", repos: [] }),
}));

vi.mock("../planGateConfig", () => ({ readPlanGateConfig: () => ({ operatorEnabled: false }) }));
vi.mock("../planGate", () => ({
  evaluatePlanGate: () => ({ allowed: true, kickPlanning: false, reason: "" }),
}));
vi.mock("../guestRepoBinding", () => ({ guestMayTargetRepo: () => true }));
vi.mock("../houseRules", () => ({ loadHouseRules: () => "" }));
vi.mock("../memory", () => ({ topMemoryEntries: () => [] }));
vi.mock("../playbooks", () => ({ loadPlaybook: () => "" }));
vi.mock("../sharedPlan", () => ({ loadSharedPlan: () => null }));
vi.mock("../peerNotes", () => ({ loadPeerNotes: () => "" }));
vi.mock("../pinnedFiles", () => ({ loadPinnedFiles: () => [] }));
vi.mock("../contextAttach", () => ({ attachReferences: () => [] }));
vi.mock("../recentDirection", () => ({ buildRecentDirection: async () => null }));
vi.mock("../styleStore", () => ({ ensureFreshStyleFingerprint: () => null }));
vi.mock("../symbolStore", () => ({ ensureFreshSymbolIndex: () => null }));
// These tests care about what reaches the spawn, not about the post-exit gate
// chain; stubbing the lifecycle keeps the repo reservation bookkeeping while
// skipping verify/critic/commit entirely.
vi.mock("../runLifecycle", async () => {
  const { releaseRepoReservation } = await import("../repoReservation");
  return {
    wireRunLifecycle: (
      _dir: string,
      sessionId: string,
      child: { on: (ev: string, cb: () => void) => void },
      repo: string,
    ) => {
      child.on("exit", () => releaseRepoReservation(repo, sessionId));
    },
  };
});

interface SpawnCall {
  kind: "spawn" | "resume";
  settings: { model?: string } | undefined;
}
const spawnCalls = vi.hoisted(() => [] as SpawnCall[]);
const liveChildren = vi.hoisted(
  () => [] as Array<ChildProcess & { emit: (ev: string, ...a: unknown[]) => boolean }>,
);

function fakeChild() {
  const ee = new EventEmitter() as unknown as ChildProcess & {
    emit: (ev: string, ...a: unknown[]) => boolean;
  };
  liveChildren.push(ee);
  return ee;
}

vi.mock("../spawn", () => ({
  spawnFreeSession: (
    _cwd: string,
    _prompt: string,
    settings: { model?: string } | undefined,
    _settingsPath: string,
    sessionId: string,
  ) => {
    spawnCalls.push({ kind: "spawn", settings });
    return { child: fakeChild(), sessionId };
  },
  resumeClaude: (
    _cwd: string,
    _sid: string,
    _msg: string,
    settings: { model?: string } | undefined,
  ) => {
    spawnCalls.push({ kind: "resume", settings });
    if (resumeShouldThrow.value) throw new Error("simulated resume spawn failure");
    return fakeChild();
  },
  denyTaskToolNames: () => ["Task"],
}));

const roleModels = vi.hoisted(() => ({ value: undefined as Record<string, string> | undefined }));
const resumeShouldThrow = vi.hoisted(() => ({ value: false }));

const FAKE_APP = {
  name: "fake-model-app",
  rawPath: "fake-model-app",
  path: TMP_SESSIONS,
  description: "",
  git: {
    branchMode: "current" as const,
    fixedBranch: "",
    autoCommit: false,
    autoPush: false,
    worktreeMode: "disabled" as const,
    mergeTargetBranch: "",
    integrationMode: "none" as const,
  },
  verify: {},
  pinnedFiles: [],
  symbolDirs: [],
  quality: {},
  retry: {},
  memory: {},
  dispatch: {},
  capabilities: [],
};

vi.mock("../apps", () => ({
  getApp: (name: string) =>
    name === "fake-model-app" ? { ...FAKE_APP, roleModels: roleModels.value } : null,
  loadApps: () => [FAKE_APP],
}));

const TASK_ID = "t_20260905_010";

function taskDir() {
  return join(TMP_SESSIONS, TASK_ID);
}

async function seedTask(taskModel?: string) {
  const { createMeta } = await import("../meta");
  createMeta(taskDir(), {
    taskId: TASK_ID,
    taskTitle: "model pinning",
    taskBody: "",
    taskStatus: "doing",
    taskSection: "DOING",
    taskChecked: false,
    ...(taskModel ? { taskModel } : {}),
    createdAt: "2026-09-05T10:00:00Z",
  });
}

async function postAgents(body: Record<string, unknown>) {
  const { POST } = await import("@/app/api/tasks/[id]/agents/route");
  const req = new Request(`http://localhost:7777/api/tasks/${TASK_ID}/agents`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return POST(req as any, { params: Promise.resolve({ id: TASK_ID }) });
}

/** Lets the spawned child exit so its repo reservation is released. */
async function drainChildren() {
  for (const c of liveChildren) c.emit("exit", 0, null);
  liveChildren.length = 0;
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
}

beforeEach(() => {
  spawnCalls.length = 0;
  liveChildren.length = 0;
  roleModels.value = undefined;
  resumeShouldThrow.value = false;
});

afterEach(async () => {
  await drainChildren();
  try { rmSync(taskDir(), { recursive: true, force: true }); } catch { }
});

describe("POST /api/tasks/<id>/agents — model resolution", () => {
  it("passes no model when nothing pins one — the pre-pinning default", async () => {
    await seedTask();
    const res = await postAgents({ role: "coder", repo: "fake-model-app", prompt: "go" });
    expect(res.status).toBe(201);
    expect(spawnCalls[0].settings?.model).toBeUndefined();
  });

  it("rejects a model that would not survive the argv guard", async () => {
    await seedTask();
    for (const model of ["--dangerously-skip-permissions", "opus 5", "../etc/passwd", 42]) {
      const res = await postAgents({
        role: "coder",
        repo: "fake-model-app",
        prompt: "go",
        model,
      });
      expect(res.status, `model=${JSON.stringify(model)}`).toBe(400);
      expect((await res.json()).error).toBe("invalid model");
    }
    expect(spawnCalls).toHaveLength(0);
  });

  it("uses the request's model over the app and task pins", async () => {
    await seedTask("claude-haiku-4-5");
    roleModels.value = { coder: "claude-sonnet-5" };
    await postAgents({
      role: "coder",
      repo: "fake-model-app",
      prompt: "go",
      model: "claude-opus-5",
    });
    expect(spawnCalls[0].settings?.model).toBe("claude-opus-5");
  });

  it("uses the app's per-role pin over the task pin, matching on the base role", async () => {
    await seedTask("claude-haiku-4-5");
    roleModels.value = { coder: "claude-sonnet-5" };
    await postAgents({ role: "coder-api", repo: "fake-model-app", prompt: "go" });
    expect(spawnCalls[0].settings?.model).toBe("claude-sonnet-5");
  });

  it("falls back to the app wildcard, then to the task pin", async () => {
    await seedTask("claude-haiku-4-5");
    roleModels.value = { coder: "claude-sonnet-5", "*": "claude-opus-5" };
    await postAgents({ role: "reviewer", repo: "fake-model-app", prompt: "go" });
    expect(spawnCalls[0].settings?.model).toBe("claude-opus-5");

    await drainChildren();
    spawnCalls.length = 0;
    roleModels.value = undefined;
    await postAgents({ role: "reviewer", repo: "fake-model-app", prompt: "go", allowDuplicate: true });
    expect(spawnCalls[0].settings?.model).toBe("claude-haiku-4-5");
  });

  it("records the resolved model on the run row", async () => {
    await seedTask("claude-opus-5");
    const res = await postAgents({ role: "coder", repo: "fake-model-app", prompt: "go" });
    const { sessionId } = await res.json();
    const { readMeta } = await import("../meta");
    expect(readMeta(taskDir())?.runs.find((r) => r.sessionId === sessionId)?.model).toBe(
      "claude-opus-5",
    );
  });
});

describe("POST /api/tasks/<id>/agents — resume re-pins the model the run was spawned with", () => {
  async function seedFinishedRun(model: string | null) {
    await seedTask();
    const { appendRun } = await import("../meta");
    const sid = "55555555-5555-5555-5555-555555555555";
    await appendRun(taskDir(), {
      sessionId: sid,
      role: "coder",
      repo: "fake-model-app",
      status: "done",
      startedAt: "2026-09-05T10:00:01Z",
      endedAt: "2026-09-05T10:00:02Z",
      model,
    });
    return sid;
  }

  it("reuses Run.model even when the app and task pins are now empty", async () => {
    const sid = await seedFinishedRun("claude-opus-5");
    const res = await postAgents({
      role: "coder",
      repo: "fake-model-app",
      prompt: "keep going",
      mode: "resume",
      priorSessionId: sid,
    });
    expect(res.status).toBe(201);
    expect(spawnCalls[0].kind).toBe("resume");
    expect(spawnCalls[0].settings?.model).toBe("claude-opus-5");
  });

  it("lets an explicit model on the resume request override the recorded one", async () => {
    const sid = await seedFinishedRun("claude-opus-5");
    await postAgents({
      role: "coder",
      repo: "fake-model-app",
      prompt: "keep going",
      mode: "resume",
      priorSessionId: sid,
      model: "claude-sonnet-5",
    });
    expect(spawnCalls[0].settings?.model).toBe("claude-sonnet-5");
  });

  it("resumes a run that predates the field with no model at all", async () => {
    const sid = await seedFinishedRun(null);
    await postAgents({
      role: "coder",
      repo: "fake-model-app",
      prompt: "keep going",
      mode: "resume",
      priorSessionId: sid,
    });
    expect(spawnCalls[0].settings?.model).toBeUndefined();
  });
});

describe("a resume that never spawns leaves the row's model as it was", () => {
  it("restores Run.model when the resume spawn throws", async () => {
    await seedTask();
    const { appendRun, readMeta } = await import("../meta");
    const sid = "66666666-6666-6666-6666-666666666666";
    await appendRun(taskDir(), {
      sessionId: sid,
      role: "coder",
      repo: "fake-model-app",
      status: "done",
      startedAt: "2026-09-05T10:00:01Z",
      endedAt: "2026-09-05T10:00:02Z",
      model: "claude-opus-5",
    });

    resumeShouldThrow.value = true;
    const res = await postAgents({
      role: "coder",
      repo: "fake-model-app",
      prompt: "keep going",
      mode: "resume",
      priorSessionId: sid,
      model: "claude-sonnet-5",
    });
    expect(res.status).toBe(500);

    const row = readMeta(taskDir())?.runs.find((r) => r.sessionId === sid);
    expect(row?.model).toBe("claude-opus-5");
    expect(row?.status).toBe("done");
  });
});
