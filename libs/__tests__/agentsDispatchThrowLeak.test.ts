import { afterEach, describe, expect, it, vi } from "vitest";
import { rmSync } from "node:fs";
import { join } from "node:path";

const TMP_SESSIONS = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { mkdtempSync } = require("node:fs") as typeof import("node:fs");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { tmpdir } = require("node:os") as typeof import("node:os");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { join } = require("node:path") as typeof import("node:path");
  return mkdtempSync(join(tmpdir(), "bridge-agents-throw-"));
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
    repos: [{ name: "fake-throw-app", score: 1, reason: "test" }],
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

vi.mock("../symbolStore", () => ({
  ensureFreshSymbolIndex: () => {
    throw new Error("symbol index boom — simulated crash before appendRunIfNotDuplicate");
  },
}));

const FAKE_APP = {
  name: "fake-throw-app",
  rawPath: "fake-throw-app",
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
  getApp: (name: string) => (name === "fake-throw-app" ? FAKE_APP : null),
  loadApps: () => [FAKE_APP],
}));

const TASK_ID = "t_20260827_003";
const HEADER = {
  taskId: TASK_ID,
  taskTitle: "throw-leak test",
  taskBody: "",
  taskStatus: "todo" as const,
  taskSection: "TODO" as const,
  taskChecked: false,
  createdAt: "2026-08-27T10:00:00Z",
};

function taskDir() {
  return join(TMP_SESSIONS, TASK_ID);
}

describe("agents route dispatch — reservation release on an unexpected pre-wire throw (Critical 2)", () => {
  afterEach(() => {
    try { rmSync(taskDir(), { recursive: true, force: true }); } catch { }
  });

  it("releases the acquired reservation when context-building throws before appendRunIfNotDuplicate", async () => {
    const { createMeta } = await import("../meta");
    const { currentReservation } = await import("../repoReservation");

    createMeta(taskDir(), HEADER);

    const { POST } = await import("@/app/api/tasks/[id]/agents/route");
    const req = new Request(`http://localhost:7777/api/tasks/${TASK_ID}/agents`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        role: "coder",
        repo: "fake-throw-app",
        prompt: "do the thing",
      }),
    });

    let threw = false;
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await POST(req as any, { params: Promise.resolve({ id: TASK_ID }) });
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);

    expect(currentReservation("fake-throw-app")).toBeNull();
  });
});
