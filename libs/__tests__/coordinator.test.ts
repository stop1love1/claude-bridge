import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChildProcess } from "node:child_process";


const spawnCalls: Array<{ cwd: string; opts: unknown }> = [];

vi.mock("../spawn", () => ({
  spawnClaude: (cwd: string, opts: unknown) => {
    spawnCalls.push({ cwd, opts });
    const child = {
      on: () => {
      },
      once: () => {
      },
    } as unknown as ChildProcess;
    return { child, sessionId: (opts as { sessionId?: string }).sessionId ?? "fake-sid" };
  },
}));

const fakeMeta: {
  taskId: string;
  taskTitle: string;
  taskBody: string;
  taskStatus: string;
  taskSection: string;
  taskChecked: boolean;
  createdAt: string;
  runs: unknown[];
  taskModel?: string | null;
} = {
  taskId: "t_20260424_001",
  taskTitle: "fake task",
  taskBody: "fake body",
  taskStatus: "todo",
  taskSection: "TODO",
  taskChecked: false,
  createdAt: "2026-04-24T00:00:00Z",
  runs: [],
};

// The coordinator resolves its model against the *bridge's* own app entry, so
// the registry is mocked here rather than read off the operator's real
// ~/.claude/bridge.json.
const getAppMock = vi.hoisted(() => vi.fn<(name: string) => unknown>());
vi.mock("../apps", () => ({ getApp: (name: string) => getAppMock(name) }));
vi.mock("../meta", () => ({
  readMeta: () => fakeMeta,
  appendRun: vi.fn().mockResolvedValue(undefined),
  updateRun: vi.fn().mockResolvedValue({ applied: true, run: null }),
}));

vi.mock("../runLifecycle", () => ({
  wireRunLifecycle: () => {
  },
}));

vi.mock("../profileStore", () => ({
  loadProfiles: () => ({ profiles: [] }),
}));
vi.mock("../repos", () => ({
  resolveRepos: () => [],
}));
vi.mock("../detect", () => ({
  getOrComputeScope: vi.fn().mockResolvedValue({ repos: [] }),
  loadDetectInput: () => ({ taskBody: "", taskTitle: "", pinnedRepo: null }),
  renderDetectedScope: () => "## Detected scope\n\n_(test scope block)_\n",
}));

beforeEach(() => {
  spawnCalls.length = 0;
  getAppMock.mockReset();
  getAppMock.mockReturnValue(null);
  fakeMeta.taskModel = null;
  vi.resetModules();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("spawnCoordinatorForTask — prompt rendering", () => {
  it("substitutes structural placeholders before user content (task body containing {{SESSION_ID}} is data, not template)", async () => {
    const template = [
      "task=`{{TASK_ID}}` sid=`{{SESSION_ID}}` repo=`{{EXAMPLE_REPO}}` folder=`{{BRIDGE_FOLDER}}`",
      "",
      "## Your job",
      "",
      "title: {{TASK_TITLE}}",
      "body: {{TASK_BODY}}",
    ].join("\n");

    vi.doMock("node:fs", async () => {
      const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
      return {
        ...actual,
        readFileSync: (p: string, enc?: BufferEncoding) => {
          if (typeof p === "string" && p.endsWith("coordinator.md")) return template;
          return actual.readFileSync(p, enc);
        },
      };
    });

    const { spawnCoordinatorForTask } = await import("../coordinator");
    const sid = await spawnCoordinatorForTask({
      id: "t_20260424_001",
      title: "title-x",
      body: "body has {{SESSION_ID}} in it and a ## Your job heading",
      app: null,
    });

    expect(sid).toBeTruthy();
    expect(spawnCalls).toHaveLength(1);
    const prompt = (spawnCalls[0].opts as { prompt: string }).prompt;

    expect(prompt).toContain(`task=\`t_20260424_001\``);
    expect(prompt).toContain(`sid=\`${sid}\``);
    expect(prompt).toContain("｛｛SESSION_ID｝｝");
    expect(prompt).not.toMatch(/^## Your job heading/m);
  });

  it("splices the Detected scope block at the structural ## Your job marker", async () => {
    const template = [
      "header line",
      "",
      "## Your job",
      "",
      "rest of the template",
    ].join("\n");

    vi.doMock("node:fs", async () => {
      const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
      return {
        ...actual,
        readFileSync: (p: string, enc?: BufferEncoding) => {
          if (typeof p === "string" && p.endsWith("coordinator.md")) return template;
          return actual.readFileSync(p, enc);
        },
      };
    });

    const { spawnCoordinatorForTask } = await import("../coordinator");
    await spawnCoordinatorForTask({
      id: "t_20260424_002",
      title: "t",
      body: "b",
      app: null,
    });

    const prompt = (spawnCalls[0].opts as { prompt: string }).prompt;
    const scopeIdx = prompt.indexOf("## Detected scope");
    const jobIdx = prompt.indexOf("## Your job");
    expect(scopeIdx).toBeGreaterThan(0);
    expect(jobIdx).toBeGreaterThan(scopeIdx);
    expect(prompt.indexOf("header line")).toBeLessThan(scopeIdx);
  });

  it("falls back to BRIDGE_FOLDER for {{EXAMPLE_REPO}} when readBridgeMd throws", async () => {
    const template = "repo=`{{EXAMPLE_REPO}}` folder=`{{BRIDGE_FOLDER}}`\n## Your job\n";

    vi.doMock("node:fs", async () => {
      const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
      return {
        ...actual,
        readFileSync: (p: string, enc?: BufferEncoding) => {
          if (typeof p === "string" && p.endsWith("coordinator.md")) return template;
          return actual.readFileSync(p, enc);
        },
      };
    });

    vi.doMock("../paths", async () => {
      const actual = await vi.importActual<typeof import("../paths")>("../paths");
      return {
        ...actual,
        readBridgeMd: () => {
          throw new Error("synthetic BRIDGE.md read failure");
        },
      };
    });

    const { spawnCoordinatorForTask } = await import("../coordinator");
    const { BRIDGE_FOLDER } = await import("../paths");
    await spawnCoordinatorForTask({
      id: "t_20260424_003",
      title: "t",
      body: "b",
      app: null,
    });

    const prompt = (spawnCalls[0].opts as { prompt: string }).prompt;
    expect(prompt).toContain(`repo=\`${BRIDGE_FOLDER}\``);
    expect(prompt).toContain(`folder=\`${BRIDGE_FOLDER}\``);
    expect(prompt).not.toContain("{{EXAMPLE_REPO}}");
    expect(prompt).not.toContain("{{BRIDGE_FOLDER}}");
  });
});

describe("spawnCoordinatorForTask — model pinning", () => {
  async function spawnAnd(): Promise<Record<string, unknown>> {
    const { spawnCoordinatorForTask } = await import("../coordinator");
    await spawnCoordinatorForTask({ id: "t_20260424_004", title: "t", body: "b", app: null });
    return (spawnCalls[0].opts as { settings: Record<string, unknown> }).settings;
  }

  it("passes no model when neither the task nor the bridge app pins one", async () => {
    expect((await spawnAnd()).model).toBeUndefined();
  });

  it("uses the task-level pin", async () => {
    fakeMeta.taskModel = "claude-opus-5";
    expect((await spawnAnd()).model).toBe("claude-opus-5");
  });

  it("lets the bridge app's coordinator pin win over the task pin", async () => {
    fakeMeta.taskModel = "claude-opus-5";
    getAppMock.mockReturnValue({ roleModels: { coordinator: "claude-sonnet-5" } });
    expect((await spawnAnd()).model).toBe("claude-sonnet-5");
  });

  it("falls back to the bridge app's wildcard pin", async () => {
    getAppMock.mockReturnValue({ roleModels: { coder: "claude-opus-5", "*": "claude-sonnet-5" } });
    expect((await spawnAnd()).model).toBe("claude-sonnet-5");
  });

  it("records the resolved model on the queued run row", async () => {
    fakeMeta.taskModel = "claude-opus-5";
    const meta = await import("../meta");
    await spawnAnd();
    expect(vi.mocked(meta.appendRun).mock.calls.at(-1)?.[1]).toMatchObject({
      model: "claude-opus-5",
    });
  });
});
