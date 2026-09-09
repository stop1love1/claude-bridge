import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ChildProcess } from "node:child_process";

/**
 * The regression this file exists for, observed live in task t_20260907_001:
 *
 *   a `ui-tester` was dispatched at 01:34:30Z — after the diff baseline
 *   shipped — wrote the `(none — analysis only)` its playbook prescribes, and
 *   the claim gate still failed it at 01:45:12Z with
 *   `agent reported "no changes" but git diff shows 43 touched file(s)`.
 *
 * The baseline was only captured on the fresh-spawn branch of
 * `POST /api/tasks/<id>/agents`. `prompts/coordinator-playbook.md` §2 makes
 * `mode: "resume"` the default for every follow-up brief, so the branch the
 * fix missed is the one nearly every child actually arrives on — no run in
 * that task's `meta.json` ever had a `diffBaseline` at all.
 */

const TMP_SESSIONS = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { mkdtempSync } = require("node:fs") as typeof import("node:fs");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { tmpdir } = require("node:os") as typeof import("node:os");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { join } = require("node:path") as typeof import("node:path");
  return mkdtempSync(join(tmpdir(), "bridge-resume-baseline-"));
});

/** The app's working tree — a real repo, because the baseline shells out to git. */
const REPO = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { mkdtempSync } = require("node:fs") as typeof import("node:fs");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { tmpdir } = require("node:os") as typeof import("node:os");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { join } = require("node:path") as typeof import("node:path");
  return mkdtempSync(join(tmpdir(), "bridge-resume-repo-"));
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
    repos: [{ name: "baseline-app", score: 1, reason: "test" }],
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
    _settings: unknown,
    _settingsPath: string,
    sessionId: string,
  ) => ({ child: fakeChild(), sessionId }),
  resumeClaude: () => fakeChild(),
  denyTaskToolNames: () => ["Task"],
}));

// The gate chain is exercised directly below via `runVerifier`; wiring the real
// lifecycle here would run it on a fake child that never exits.
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

const FAKE_APP = {
  name: "baseline-app",
  rawPath: "baseline-app",
  path: REPO,
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
  getApp: (name: string) => (name === "baseline-app" ? FAKE_APP : null),
  loadApps: () => [FAKE_APP],
  isValidAppName: (n: unknown) => typeof n === "string" && /^[a-zA-Z0-9._-]+$/.test(n),
}));

const TASK_ID = "t_20260909_003";
const PRIOR_SID = "dddddddd-1111-2222-3333-444444444444";

function taskDir() {
  return join(TMP_SESSIONS, TASK_ID);
}

function git(...args: string[]): void {
  execFileSync("git", args, { cwd: REPO, stdio: "ignore", windowsHide: true });
}

function write(rel: string, body: string): void {
  const abs = join(REPO, rel);
  mkdirSync(abs.replace(/[\\/][^\\/]+$/, ""), { recursive: true });
  writeFileSync(abs, body, "utf8");
}

function writeReport(role: string, changedFiles: string[]): void {
  const dir = join(taskDir(), "reports");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${role}-baseline-app.md`),
    [
      `# ${role} @ baseline-app`,
      "",
      "## Changed files",
      ...changedFiles,
      "",
      "## How to verify",
      "Run the tests.",
      "",
    ].join("\n"),
    "utf8",
  );
}

async function seedFinishedRun(role: string) {
  const { createMeta, appendRun } = await import("../meta");
  createMeta(taskDir(), {
    taskId: TASK_ID,
    taskTitle: "baseline on resume",
    taskBody: "",
    taskStatus: "doing",
    taskSection: "DOING",
    taskChecked: false,
    createdAt: "2026-09-09T10:00:00Z",
  });
  await appendRun(taskDir(), {
    sessionId: PRIOR_SID,
    role,
    repo: "baseline-app",
    status: "done",
    startedAt: "2026-09-09T10:00:01Z",
    endedAt: "2026-09-09T10:00:02Z",
  });
}

async function postResume(role: string) {
  const { POST } = await import("@/app/api/tasks/[id]/agents/route");
  const req = new Request(`http://localhost:7777/api/tasks/${TASK_ID}/agents`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      role,
      repo: "baseline-app",
      prompt: "next brief for this same agent",
      mode: "resume",
      priorSessionId: PRIOR_SID,
    }),
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return POST(req as any, { params: Promise.resolve({ id: TASK_ID }) });
}

async function resumedRun() {
  const { readMeta } = await import("../meta");
  const run = readMeta(taskDir())?.runs.find((r) => r.sessionId === PRIOR_SID);
  if (!run) throw new Error("resumed run row vanished");
  return run;
}

async function drainChildren() {
  for (const c of liveChildren) c.emit("exit", 0, null);
  liveChildren.length = 0;
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
}

beforeEach(() => {
  liveChildren.length = 0;
  rmSync(REPO, { recursive: true, force: true });
  mkdirSync(REPO, { recursive: true });
  git("init", "-q");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
  git("config", "commit.gpgsign", "false");
  write("math.ts", "export const add = (a: number, b: number) => a + b;\n");
  write("README.md", "# fixture\n");
  git("add", "-A");
  git("commit", "-qm", "seed");
});

afterEach(async () => {
  await drainChildren();
  try { rmSync(taskDir(), { recursive: true, force: true }); } catch { }
});

describe("POST /api/tasks/<id>/agents with mode:'resume' — the diff baseline", () => {
  it("records a baseline on the run row, which the fresh-spawn-only fix never did", async () => {
    await seedFinishedRun("ui-tester");
    // A coder ran earlier in this task and the bridge has not committed yet.
    write("math.ts", "// the coder's work\n");
    write("README.md", "# the coder's work\n");

    const res = await postResume("ui-tester");
    expect(res.status).toBe(201);

    const run = await resumedRun();
    expect(run.diffBaseline, "resume must snapshot the tree it is about to work in").toBeTruthy();
    expect(Object.keys(run.diffBaseline!.files).sort()).toEqual(["README.md", "math.ts"]);
  });

  it("lets a read-only resume report (none — analysis only) and pass the claim gate", async () => {
    await seedFinishedRun("ui-tester");
    write("math.ts", "// the coder's work\n");
    write("README.md", "# the coder's work\n");

    await postResume("ui-tester");
    const run = await resumedRun();

    writeReport("ui-tester", ["- (none — analysis only)"]);
    const { runVerifier } = await import("../verifier");
    const v = await runVerifier({ appPath: REPO, taskId: TASK_ID, finishedRun: run });

    expect(v.verdict).toBe("pass");
    expect(v.reason).toContain("predate this run");
    expect(v.unclaimedActual).toEqual([]);
  });

  it("still catches a read-only resume that edited code and declared nothing", async () => {
    await seedFinishedRun("ui-tester");
    write("math.ts", "// the coder's work\n");

    await postResume("ui-tester");
    const run = await resumedRun();

    // …and then the resumed agent quietly touched something of its own.
    write("README.md", "# edited by the ui-tester, undeclared\n");

    writeReport("ui-tester", ["- (none — analysis only)"]);
    const { runVerifier } = await import("../verifier");
    const v = await runVerifier({ appPath: REPO, taskId: TASK_ID, finishedRun: run });

    expect(v.verdict).toBe("broken");
    expect(v.reason).toContain("silent edits");
    expect(v.unclaimedActual).toEqual(["README.md"]);
  });

  it("re-snapshots each turn, so a coder still declares what it changes this time", async () => {
    await seedFinishedRun("coder");
    // Turn 1 of this same agent already landed these.
    write("math.ts", "// turn 1\n");

    await postResume("coder");
    const run = await resumedRun();
    expect(Object.keys(run.diffBaseline!.files)).toEqual(["math.ts"]);

    // Turn 2's own work.
    write("README.md", "# turn 2\n");
    const { runVerifier } = await import("../verifier");

    writeReport("coder", ["- (none — analysis only)"]);
    expect(
      (await runVerifier({ appPath: REPO, taskId: TASK_ID, finishedRun: run })).verdict,
    ).toBe("broken");

    writeReport("coder", ["- `README.md` — turn 2's change"]);
    expect(
      (await runVerifier({ appPath: REPO, taskId: TASK_ID, finishedRun: run })).verdict,
    ).toBe("pass");
  });
});
