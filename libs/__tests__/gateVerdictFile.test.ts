import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { EventEmitter } from "node:events";
import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
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
  return mkdtempSync(join(tmpdir(), "bridge-verdictfile-"));
});

const h = vi.hoisted(() => {
  const state = {
    panelSize: 3,
    prompts: [] as string[],
    verdictByLens: {} as Record<string, unknown>,
    sessionsDir: "",
  };
  const verdictFileNamesIn = (prompt: string): string[] => {
    const out = new Set<string>();
    const re = /`([A-Za-z0-9._-]*verdict[A-Za-z0-9._-]*\.json)`/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(prompt)) !== null) out.add(m[1]);
    return [...out];
  };
  const lensOf = (prompt: string): string =>
    /## Lens: (\S+)/.exec(prompt)?.[1] ?? "default";
  return { state, verdictFileNamesIn, lensOf };
});

const { state, verdictFileNamesIn } = h;

vi.mock("../paths", async () => {
  const actual = await vi.importActual<typeof import("../paths")>("../paths");
  return { ...actual, SESSIONS_DIR: TMP_SESSIONS };
});

const notifyGateInfraSkip = vi.fn().mockResolvedValue(undefined);
vi.mock("../gateEscalation", async () => {
  const actual =
    await vi.importActual<typeof import("../gateEscalation")>("../gateEscalation");
  return { ...actual, notifyGateInfraSkip: (o: unknown) => notifyGateInfraSkip(o) };
});

vi.mock("../meta", async () => {
  const actual = await vi.importActual<typeof import("../meta")>("../meta");
  return {
    ...actual,
    appendRun: vi.fn().mockResolvedValue(undefined),
    updateRun: vi.fn().mockResolvedValue(undefined),
  };
});

vi.mock("../apps", async () => {
  const actual = await vi.importActual<typeof import("../apps")>("../apps");
  return {
    ...actual,
    getApp: () => ({
      name: "real-app",
      path: "/tmp/fake-app",
      quality: { verifierPanel: h.state.panelSize, criticPanel: h.state.panelSize },
    }),
  };
});

vi.mock("../houseRules", async () => {
  const actual = await vi.importActual<typeof import("../houseRules")>("../houseRules");
  return { ...actual, loadHouseRules: () => null };
});
vi.mock("../memory", async () => {
  const actual = await vi.importActual<typeof import("../memory")>("../memory");
  return { ...actual, topMemoryEntries: () => [] };
});
vi.mock("../symbolStore", async () => {
  const actual = await vi.importActual<typeof import("../symbolStore")>("../symbolStore");
  return { ...actual, ensureFreshSymbolIndex: () => null };
});
vi.mock("../styleStore", async () => {
  const actual = await vi.importActual<typeof import("../styleStore")>("../styleStore");
  return { ...actual, ensureFreshStyleFingerprint: () => null };
});
vi.mock("../pinnedFiles", async () => {
  const actual = await vi.importActual<typeof import("../pinnedFiles")>("../pinnedFiles");
  return { ...actual, loadPinnedFiles: () => [] };
});
vi.mock("../permissionSettings", async () => {
  const actual =
    await vi.importActual<typeof import("../permissionSettings")>("../permissionSettings");
  return {
    ...actual,
    writeSessionSettings: (p: string) => p,
    freeSessionSettingsPath: (sid: string) => `settings-${sid}.json`,
  };
});

vi.mock("../spawn", async () => {
  const actual = await vi.importActual<typeof import("../spawn")>("../spawn");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { EventEmitter } = require("node:events") as typeof import("node:events");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { writeFileSync } = require("node:fs") as typeof import("node:fs");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { join } = require("node:path") as typeof import("node:path");

  return {
    ...actual,
    spawnFreeSession: (_cwd: string, prompt: string) => {
      h.state.prompts.push(prompt);
      const names = h.verdictFileNamesIn(prompt);
      const lens = h.lensOf(prompt);
      if (names.length === 1) {
        const body = h.state.verdictByLens[lens] ?? h.state.verdictByLens.default;
        writeFileSync(join(h.state.sessionsDir, names[0]), JSON.stringify(body));
      }
      const ee = new EventEmitter() as unknown as ChildProcess & EventEmitter;
      setImmediate(() => ee.emit("exit", 0));
      return { child: ee, sessionId: "sid" };
    },
  };
});

import { runSemanticVerifier } from "../semanticVerifier";
import { runStyleCritic } from "../styleCritic";

const TASK_ID = "t_20260827_036";

const finishedRun: Run = {
  sessionId: "11111111-1111-1111-1111-111111111111",
  role: "coder",
  repo: "real-app",
  status: "done",
  startedAt: null,
  endedAt: null,
  parentSessionId: "00000000-0000-0000-0000-000000000000",
};

function gateOpts() {
  return {
    appPath: "/tmp/fake-app",
    taskId: TASK_ID,
    finishedRun,
    taskTitle: "t",
    taskBody: "b",
  };
}

beforeEach(() => {
  notifyGateInfraSkip.mockClear();
  state.prompts = [];
  state.panelSize = 3;
  state.verdictByLens = {};
  state.sessionsDir = join(TMP_SESSIONS, TASK_ID);
  rmSync(state.sessionsDir, { recursive: true, force: true });
  mkdirSync(state.sessionsDir, { recursive: true });
});

afterAll(() => {
  try { rmSync(TMP_SESSIONS, { recursive: true, force: true }); } catch { }
});

describe("gate children are told the verdict filename the bridge reads", () => {
  it("semantic panel: every lens child's verdict is read back (three votes, not zero)", async () => {
    state.verdictByLens = {
      default: { verdict: "pass", reason: "delivered", concerns: [] },
    };

    const out = await runSemanticVerifier(gateOpts());

    expect(out.panelSize).toBe(3);
    expect(out.votes?.map((v) => v.lens)).toEqual([
      "correctness",
      "edge-cases",
      "regression",
    ]);
    expect(out.verdict).toBe("pass");
    expect(notifyGateInfraSkip).not.toHaveBeenCalled();
  });

  it("semantic panel: the three lens children are told three distinct filenames", async () => {
    state.verdictByLens = {
      default: { verdict: "pass", reason: "delivered", concerns: [] },
    };

    await runSemanticVerifier(gateOpts());

    const told = state.prompts.map((p) => verdictFileNamesIn(p));
    expect(told.map((names) => names.length)).toEqual([1, 1, 1]);
    const flat = told.map((names) => names[0]);
    expect(new Set(flat).size).toBe(3);
    for (const name of flat) {
      expect(existsSync(join(state.sessionsDir, name))).toBe(true);
    }
    expect(readdirSync(state.sessionsDir).sort()).toEqual([...flat].sort());
  });

  it("semantic panel: two broken of three blocks with `broken` (majority)", async () => {
    state.verdictByLens = {
      correctness: { verdict: "broken", reason: "endpoint missing", concerns: ["c1"] },
      "edge-cases": { verdict: "broken", reason: "null blows up", concerns: ["c2"] },
      regression: { verdict: "pass", reason: "nothing else touched", concerns: [] },
    };

    const out = await runSemanticVerifier(gateOpts());

    expect(out.verdict).toBe("broken");
    expect(out.reason).toContain("endpoint missing");
    expect(out.concerns).toEqual(expect.arrayContaining(["c1", "c2"]));
  });

  it("semantic panel: a lone broken of three downgrades to `drift`", async () => {
    state.verdictByLens = {
      correctness: { verdict: "broken", reason: "endpoint missing", concerns: ["c1"] },
      "edge-cases": { verdict: "pass", reason: "ok", concerns: [] },
      regression: { verdict: "pass", reason: "ok", concerns: [] },
    };

    const out = await runSemanticVerifier(gateOpts());

    expect(out.verdict).toBe("drift");
    expect(out.concerns).toContain("c1");
  });

  it("semantic panel of two: one usable vote is inconclusive, not a decision", async () => {
    state.panelSize = 2;
    state.verdictByLens = {
      correctness: { verdict: "pass", reason: "delivered", concerns: [] },
      "edge-cases": { verdict: "not-a-verdict", reason: "junk" },
    };

    const out = await runSemanticVerifier(gateOpts());

    expect(out.panelSize).toBe(2);
    expect(out.votes).toHaveLength(1);
    expect(out.verdict).toBe("skipped");
  });

  it("semantic panel of two: a lone broken does not block on its own", async () => {
    state.panelSize = 2;
    state.verdictByLens = {
      correctness: { verdict: "broken", reason: "endpoint missing", concerns: ["c1"] },
      "edge-cases": { verdict: "pass", reason: "ok", concerns: [] },
    };

    const out = await runSemanticVerifier(gateOpts());

    expect(out.panelSize).toBe(2);
    expect(out.verdict).toBe("drift");
    expect(out.concerns).toContain("c1");
  });

  it("semantic panel of two: both judges reporting broken still blocks", async () => {
    state.panelSize = 2;
    state.verdictByLens = {
      correctness: { verdict: "broken", reason: "endpoint missing", concerns: ["c1"] },
      "edge-cases": { verdict: "broken", reason: "null blows up", concerns: ["c2"] },
    };

    const out = await runSemanticVerifier(gateOpts());

    expect(out.verdict).toBe("broken");
    expect(out.concerns).toEqual(expect.arrayContaining(["c1", "c2"]));
  });

  it("a panel configured larger than the lens set runs the lens set, and says so", async () => {
    state.panelSize = 5;
    state.verdictByLens = {
      default: { verdict: "pass", reason: "delivered", concerns: [] },
    };

    const out = await runSemanticVerifier(gateOpts());

    expect(out.panelSize).toBe(3);
    expect(out.votes).toHaveLength(3);
    expect(state.prompts).toHaveLength(3);
  });

  it("semantic single verifier (panelSize 1) reads back the verdict too", async () => {
    state.panelSize = 1;
    state.verdictByLens = {
      default: { verdict: "pass", reason: "delivered", concerns: [] },
    };

    const out = await runSemanticVerifier(gateOpts());

    expect(out.panelSize).toBe(1);
    expect(out.verdict).toBe("pass");
    expect(state.prompts).toHaveLength(1);
    expect(verdictFileNamesIn(state.prompts[0])).toHaveLength(1);
    expect(notifyGateInfraSkip).not.toHaveBeenCalled();
  });

  it("style panel: every lens child's verdict is read back (three votes, not zero)", async () => {
    state.verdictByLens = {
      default: { verdict: "match", reason: "fits", issues: [] },
    };

    const out = await runStyleCritic(gateOpts());

    expect(out.panelSize).toBe(3);
    expect(out.votes?.map((v) => v.lens)).toEqual(["conventions", "reuse", "naming"]);
    expect(out.verdict).toBe("match");
    expect(notifyGateInfraSkip).not.toHaveBeenCalled();
  });

  it("style panel: two alien of three blocks with `alien` (majority)", async () => {
    state.verdictByLens = {
      conventions: { verdict: "alien", reason: "raw fetch", issues: ["i1"] },
      reuse: { verdict: "alien", reason: "reinvented cn()", issues: ["i2"] },
      naming: { verdict: "match", reason: "names fine", issues: [] },
    };

    const out = await runStyleCritic(gateOpts());

    expect(out.verdict).toBe("alien");
    expect(out.issues).toEqual(expect.arrayContaining(["i1", "i2"]));
  });

  it("style single critic (panelSize 1) reads back the verdict too", async () => {
    state.panelSize = 1;
    state.verdictByLens = {
      default: { verdict: "match", reason: "fits", issues: [] },
    };

    const out = await runStyleCritic(gateOpts());

    expect(out.panelSize).toBe(1);
    expect(out.verdict).toBe("match");
    expect(verdictFileNamesIn(state.prompts[0])).toHaveLength(1);
  });

  it("no gate prompt names a second, competing verdict filename", async () => {
    state.verdictByLens = {
      default: { verdict: "pass", reason: "ok", concerns: [] },
    };
    await runSemanticVerifier(gateOpts());
    state.verdictByLens = {
      default: { verdict: "match", reason: "ok", issues: [] },
    };
    await runStyleCritic(gateOpts());

    expect(state.prompts.length).toBeGreaterThan(0);
    for (const prompt of state.prompts) {
      expect(verdictFileNamesIn(prompt)).toHaveLength(1);
    }
  });
});
