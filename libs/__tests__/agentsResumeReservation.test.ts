import { afterEach, describe, expect, it, vi } from "vitest";
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
  return mkdtempSync(join(tmpdir(), "bridge-agents-resume-"));
});

vi.mock("../paths", async () => {
  const actual = await vi.importActual<typeof import("../paths")>("../paths");
  return { ...actual, SESSIONS_DIR: TMP_SESSIONS };
});

vi.mock("../auth", () => ({
  verifyRequestActor: () => null,
}));

vi.mock("../detect", () => ({
  getOrComputeScope: async () => ({
    source: "heuristic",
    reason: "test",
    repos: [{ name: "fake-resume-app", score: 1, reason: "test" }],
  }),
  loadDetectInput: () => ({ taskBody: "", repos: [] }),
}));

vi.mock("../planGateConfig", () => ({
  readPlanGateConfig: () => ({ operatorEnabled: false }),
}));

vi.mock("../planGate", () => ({
  evaluatePlanGate: () => ({ allowed: true, kickPlanning: false, reason: "" }),
}));

vi.mock("../guestRepoBinding", () => ({
  guestMayTargetRepo: () => true,
}));

vi.mock("../houseRules", () => ({ loadHouseRules: () => "" }));
vi.mock("../memory", () => ({ topMemoryEntries: () => [] }));
vi.mock("../playbooks", () => ({ loadPlaybook: () => "" }));
vi.mock("../sharedPlan", () => ({ loadSharedPlan: () => null }));
vi.mock("../peerNotes", () => ({ loadPeerNotes: () => [] }));
vi.mock("../pinnedFiles", () => ({ loadPinnedFiles: () => [] }));
vi.mock("../contextAttach", () => ({ attachReferences: () => [] }));
vi.mock("../recentDirection", () => ({ buildRecentDirection: async () => null }));
vi.mock("../styleStore", () => ({ ensureFreshStyleFingerprint: () => null }));
vi.mock("../symbolStore", () => ({ ensureFreshSymbolIndex: () => null }));

const resumedChildren: (ChildProcess & { emit: (ev: string, ...args: unknown[]) => boolean })[] = [];
function fakeChild(): ChildProcess & { emit: (ev: string, ...args: unknown[]) => boolean } {
  const ee = new EventEmitter() as unknown as ChildProcess & {
    emit: (ev: string, ...args: unknown[]) => boolean;
  };
  return ee;
}

vi.mock("../spawn", () => ({
  resumeClaude: () => {
    const child = fakeChild();
    resumedChildren.push(child);
    return child;
  },
  spawnFreeSession: () => {
    throw new Error("spawnFreeSession should not be reached in these resume tests");
  },
}));

const FAKE_APP = {
  name: "fake-resume-app",
  rawPath: "fake-resume-app",
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
  getApp: (name: string) => (name === "fake-resume-app" ? FAKE_APP : null),
  loadApps: () => [FAKE_APP],
}));

const TASK_ID = "t_20260827_004";
const HEADER = {
  taskId: TASK_ID,
  taskTitle: "resume reservation test",
  taskBody: "",
  taskStatus: "doing" as const,
  taskSection: "DOING" as const,
  taskChecked: false,
  createdAt: "2026-08-27T10:00:00Z",
};

function taskDir() {
  return join(TMP_SESSIONS, TASK_ID);
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

describe("agents route resume — repo reservation acquisition (Important 4)", () => {
  afterEach(() => {
    resumedChildren.length = 0;
    try { rmSync(taskDir(), { recursive: true, force: true }); } catch { }
  });

  it("acquires the app's reservation on resume and refuses a concurrent fresh dispatch to the same app", async () => {
    const { createMeta, appendRun } = await import("../meta");
    const { currentReservation } = await import("../repoReservation");

    createMeta(taskDir(), HEADER);
    const priorSid = "55555555-5555-5555-5555-555555555555";
    await appendRun(taskDir(), {
      sessionId: priorSid,
      role: "coder",
      repo: "fake-resume-app",
      status: "done",
      startedAt: "2026-08-27T10:00:01Z",
      endedAt: "2026-08-27T10:00:02Z",
    });

    const resumeRes = await postAgents({
      role: "coder",
      repo: "fake-resume-app",
      prompt: "keep going",
      mode: "resume",
      priorSessionId: priorSid,
    });
    expect(resumeRes.status).toBe(201);
    expect(currentReservation("fake-resume-app")?.sessionId).toBe(priorSid);

    const blockedRes = await postAgents({
      role: "reviewer",
      repo: "fake-resume-app",
      prompt: "fresh dispatch while the resumed run is still live",
    });
    expect(blockedRes.status).toBe(409);
    const blockedBody = await blockedRes.json();
    expect(blockedBody.heldBy).toBe(priorSid);

    expect(resumedChildren).toHaveLength(1);
    resumedChildren[0].emit("exit", 0, null);
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    expect(currentReservation("fake-resume-app")).toBeNull();
  });

  it("rolls the claim back and reports the holder when the app is already reserved by a different session", async () => {
    const { createMeta, appendRun, readMeta } = await import("../meta");
    const { acquireRepoReservation, releaseRepoReservation, currentReservation } =
      await import("../repoReservation");

    releaseRepoReservation("fake-resume-app", "other-holder");
    createMeta(taskDir(), HEADER);
    const priorSid = "66666666-6666-6666-6666-666666666666";
    await appendRun(taskDir(), {
      sessionId: priorSid,
      role: "coder",
      repo: "fake-resume-app",
      status: "failed",
      startedAt: "2026-08-27T10:00:01Z",
      endedAt: "2026-08-27T10:00:02Z",
    });
    acquireRepoReservation("fake-resume-app", "other-holder");
    expect(currentReservation("fake-resume-app")?.sessionId).toBe("other-holder");

    const resumeRes = await postAgents({
      role: "coder",
      repo: "fake-resume-app",
      prompt: "keep going",
      mode: "resume",
      priorSessionId: priorSid,
    });
    expect(resumeRes.status).toBe(409);
    const body = await resumeRes.json();
    expect(body.heldBy).toBe("other-holder");

    const meta = readMeta(taskDir());
    const run = meta?.runs.find((r) => r.sessionId === priorSid);
    expect(run?.status).toBe("failed");
    expect(resumedChildren).toHaveLength(0);

    releaseRepoReservation("fake-resume-app", "other-holder");
  });
});
