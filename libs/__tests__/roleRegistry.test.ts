import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { rmSync } from "node:fs";
import { join } from "node:path";
import {
  disallowedToolsForRole,
  listRoles,
  mergeDisallowedTools,
  resolveRole,
} from "../roleRegistry";
import { isMutatingRole } from "../planGate";

const READ_ONLY_DENY = ["Edit", "MultiEdit", "NotebookEdit", "Task"];

describe("roleRegistry.resolveRole", () => {
  it("reviewer-api resolves to reviewer and denies edit tools plus Task", () => {
    const spec = resolveRole("reviewer-api");
    expect(spec.name).toBe("reviewer");
    expect(spec.mutating).toBe(false);
    for (const t of READ_ONLY_DENY) expect(spec.disallowedTools).toContain(t);
    expect(spec.disallowedTools).not.toContain("Bash");
    expect(spec.disallowedTools).not.toContain("Write");
  });

  it("coder denies only Task", () => {
    const spec = resolveRole("coder");
    expect(spec.mutating).toBe(true);
    expect(spec.disallowedTools).toEqual(["Task"]);
  });

  it("unknown roles fall back to mutating with only Task denied", () => {
    const spec = resolveRole("wizard-of-oz");
    expect(spec.name).toBe("wizard-of-oz");
    expect(spec.mutating).toBe(true);
    expect(spec.disallowedTools).toEqual(["Task"]);
    expect(spec.playbook).toBeNull();
  });

  it("prefix-matches suffixed variants and is case-insensitive", () => {
    expect(resolveRole("coder-phase24").name).toBe("coder");
    expect(resolveRole("fixer-cashier").name).toBe("fixer");
    expect(resolveRole("Planner-API").name).toBe("planner");
    expect(resolveRole("reviewer-2").mutating).toBe(false);
    expect(resolveRole("ui-tester-checkout").mutating).toBe(false);
  });

  it("does not treat a bare prefix without the dash as a match", () => {
    // `coders` is not `coder-…`; it must fall back to the default spec.
    expect(resolveRole("coders").name).toBe("coders");
    expect(resolveRole("plannerx").mutating).toBe(true);
  });

  it("every contract-listed non-mutating role denies the read-only set", () => {
    const nonMutating = [
      "planner",
      "reviewer",
      "researcher",
      "surveyor",
      "ui-tester",
      "semantic-verifier",
      "style-critic",
      "memory-distill",
      "devops",
    ];
    for (const r of nonMutating) {
      const spec = resolveRole(r);
      expect(spec.mutating, r).toBe(false);
      for (const t of READ_ONLY_DENY) expect(spec.disallowedTools, r).toContain(t);
    }
  });

  it("reports the playbook basename when a playbook file exists", () => {
    // prompts/playbooks/planner.md ships with the repo.
    expect(resolveRole("planner").playbook).toBe("planner");
    expect(resolveRole("coder").playbook).toBeNull();
  });
});

describe("roleRegistry.listRoles", () => {
  it("returns every registered role with a full RoleSpec shape", () => {
    const roles = listRoles();
    expect(roles.length).toBeGreaterThan(5);
    for (const spec of roles) {
      expect(typeof spec.name).toBe("string");
      expect(typeof spec.mutating).toBe("boolean");
      expect(Array.isArray(spec.disallowedTools)).toBe(true);
      expect(spec.disallowedTools).toContain("Task");
      expect(spec.playbook === null || typeof spec.playbook === "string").toBe(true);
      expect(typeof spec.description).toBe("string");
    }
    const names = roles.map((r) => r.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("returns fresh arrays so callers cannot mutate the registry", () => {
    listRoles()[0].disallowedTools.push("Bash");
    expect(listRoles()[0].disallowedTools).not.toContain("Bash");
  });
});

describe("roleRegistry.mergeDisallowedTools", () => {
  it("dedupes while preserving order and never drops Task", () => {
    expect(mergeDisallowedTools(["Task"], ["Edit", "Task", "MultiEdit"])).toEqual([
      "Task",
      "Edit",
      "MultiEdit",
    ]);
    expect(mergeDisallowedTools(undefined, ["Task"])).toEqual(["Task"]);
    expect(mergeDisallowedTools()).toEqual([]);
  });

  it("disallowedToolsForRole is a thin alias over resolveRole", () => {
    expect(disallowedToolsForRole("style-critic-2")).toEqual(resolveRole("style-critic").disallowedTools);
  });
});

describe("planGate.isMutatingRole delegates to the registry", () => {
  it("keeps every pre-existing classification", () => {
    for (const r of ["coder", "fixer", "coder-phase24", "fixer-cashier"]) {
      expect(isMutatingRole(r), r).toBe(true);
    }
    for (const r of ["planner", "reviewer", "ui-tester", "semantic-verifier", "style-critic", "devops"]) {
      expect(isMutatingRole(r), r).toBe(false);
    }
    expect(isMutatingRole("planner-api")).toBe(false);
    expect(isMutatingRole("reviewer-2")).toBe(false);
  });

  it("agrees with resolveRole for every registered role", () => {
    for (const spec of listRoles()) {
      expect(isMutatingRole(spec.name)).toBe(spec.mutating);
    }
  });
});

// ---------------------------------------------------------------------------
// Route-level probe: the `/agents` dispatch route must thread the registry's
// deny-list into the real spawn / resume argv, not just compute it.
// ---------------------------------------------------------------------------

const TMP_SESSIONS = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { mkdtempSync } = require("node:fs") as typeof import("node:fs");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { tmpdir } = require("node:os") as typeof import("node:os");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { join } = require("node:path") as typeof import("node:path");
  return mkdtempSync(join(tmpdir(), "bridge-role-registry-"));
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
    repos: [{ name: "fake-role-app", score: 1, reason: "test" }],
    features: [],
    entities: [],
    files: [],
    confidence: "high",
    detectedAt: "2026-09-05T10:00:00Z",
  }),
  loadDetectInput: () => ({ taskBody: "", repos: [] }),
}));

vi.mock("../planGateConfig", () => ({
  readPlanGateConfig: () => ({ operatorEnabled: false }),
}));

vi.mock("../guestRepoBinding", () => ({
  guestMayTargetRepo: () => true,
}));

vi.mock("../houseRules", () => ({ loadHouseRules: () => null }));
vi.mock("../memory", () => ({ topMemoryEntries: () => [] }));
vi.mock("../playbooks", async () => {
  const actual = await vi.importActual<typeof import("../playbooks")>("../playbooks");
  return { ...actual, loadPlaybook: () => "" };
});
vi.mock("../sharedPlan", () => ({ loadSharedPlan: () => null }));
vi.mock("../peerNotes", () => ({ loadPeerNotes: () => null }));
vi.mock("../pinnedFiles", () => ({ loadPinnedFiles: () => [] }));
vi.mock("../contextAttach", () => ({ attachReferences: () => [] }));
vi.mock("../recentDirection", () => ({ buildRecentDirection: async () => null }));
vi.mock("../styleStore", () => ({ ensureFreshStyleFingerprint: () => null }));
vi.mock("../symbolStore", () => ({ ensureFreshSymbolIndex: () => null }));
vi.mock("../profileStore", () => ({ loadProfiles: () => null }));
vi.mock("../systemPrompt", async () => {
  const actual = await vi.importActual<typeof import("../systemPrompt")>("../systemPrompt");
  return { ...actual, ensureSystemPromptFile: () => null };
});
vi.mock("../permissionSettings", async () => {
  const actual = await vi.importActual<typeof import("../permissionSettings")>("../permissionSettings");
  return {
    ...actual,
    writeSessionSettings: (p: string) => p,
    freeSessionSettingsPath: (sid: string) => `settings-${sid}.json`,
  };
});
vi.mock("../repos", () => ({
  resolveRepos: () => [
    { name: "fake-role-app", path: TMP_SESSIONS },
    { name: "fake-role-app-2", path: TMP_SESSIONS },
  ],
  resolveRepoCwd: (_md: string, _root: string, name: string) =>
    name === "fake-role-app" || name === "fake-role-app-2" ? TMP_SESSIONS : null,
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

vi.mock("../coordinator", async () => {
  const actual = await vi.importActual<typeof import("../coordinator")>("../coordinator");
  return { ...actual, wireRunLifecycle: vi.fn(), spawnCoordinatorForTask: vi.fn() };
});

function fakeApp(name: string) {
  return {
    name,
    rawPath: name,
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
}
const FAKE_APPS = [fakeApp("fake-role-app"), fakeApp("fake-role-app-2")];

vi.mock("../apps", () => ({
  getApp: (name: string) => FAKE_APPS.find((a) => a.name === name) ?? null,
  loadApps: () => FAKE_APPS,
}));

const TASK_ID = "t_20260905_777";
const COORD_SID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const HEADER = {
  taskId: TASK_ID,
  taskTitle: "role registry spawn probe",
  taskBody: "",
  taskStatus: "doing" as const,
  taskSection: "DOING" as const,
  taskChecked: false,
  createdAt: "2026-09-05T10:00:00Z",
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

describe("agents route threads the registry deny-list into spawn settings", () => {
  beforeEach(() => {
    spawnFreeSessionMock.mockReset();
    spawnFreeSessionMock.mockImplementation((_cwd, _prompt, _settings, _sp, sessionId) => ({
      child: { once: () => { }, on: () => { } },
      sessionId,
    }));
    resumeClaudeMock.mockReset();
    resumeClaudeMock.mockReturnValue({ once: () => { }, on: () => { } });
  });

  afterEach(async () => {
    const { releaseRepoReservation, currentReservation } = await import("../repoReservation");
    for (const a of FAKE_APPS) {
      const held = currentReservation(a.name);
      if (held) releaseRepoReservation(a.name, held.sessionId);
    }
    try { rmSync(taskDir(), { recursive: true, force: true }); } catch { }
  });

  it("fresh spawn of reviewer-api denies Edit/MultiEdit/NotebookEdit/Task", async () => {
    const { createMeta } = await import("../meta");
    createMeta(taskDir(), HEADER);

    const res = await postAgents({
      role: "reviewer-api",
      repo: "fake-role-app",
      prompt: "review the api module",
      parentSessionId: COORD_SID,
    });
    expect(res.status).toBe(201);
    expect(spawnFreeSessionMock).toHaveBeenCalledTimes(1);
    const settings = spawnFreeSessionMock.mock.calls[0][2] as { disallowedTools?: string[] };
    for (const t of READ_ONLY_DENY) expect(settings.disallowedTools).toContain(t);
    expect(settings.disallowedTools).not.toContain("Bash");
    expect(settings.disallowedTools).not.toContain("Write");
  });

  it("fresh spawn of coder denies only Task", async () => {
    const { createMeta } = await import("../meta");
    createMeta(taskDir(), HEADER);

    const res = await postAgents({
      role: "coder",
      repo: "fake-role-app",
      prompt: "implement the thing",
      parentSessionId: COORD_SID,
    });
    expect(res.status).toBe(201);
    const settings = spawnFreeSessionMock.mock.calls[0][2] as { disallowedTools?: string[] };
    expect(settings.disallowedTools).toEqual(["Task"]);
  });

  it("resume of a finished reviewer threads the same deny-list into resumeClaude", async () => {
    const { createMeta, appendRun } = await import("../meta");
    createMeta(taskDir(), HEADER);
    const priorSid = "11111111-2222-4333-8444-555555555555";
    await appendRun(taskDir(), {
      sessionId: priorSid,
      role: "reviewer",
      repo: "fake-role-app-2",
      status: "done",
      startedAt: "2026-09-05T10:00:00Z",
      endedAt: "2026-09-05T10:05:00Z",
      parentSessionId: COORD_SID,
    });

    const res = await postAgents({
      role: "reviewer",
      repo: "fake-role-app-2",
      prompt: "re-check the follow-up",
      parentSessionId: COORD_SID,
      mode: "resume",
    });
    expect(res.status).toBe(201);
    expect(((await res.json()) as { action: string }).action).toBe("resumed");
    expect(resumeClaudeMock).toHaveBeenCalledTimes(1);
    expect(spawnFreeSessionMock).not.toHaveBeenCalled();
    const settings = resumeClaudeMock.mock.calls[0][3] as { disallowedTools?: string[] };
    for (const t of READ_ONLY_DENY) expect(settings.disallowedTools).toContain(t);
  });
});
