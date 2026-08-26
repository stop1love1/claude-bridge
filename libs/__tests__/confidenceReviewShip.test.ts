/**
 * H6 (audit) — the confidence review route's live-tree `ship` branch
 * calls `autoCommitAndPush` and, on a REJECTED push (`{ok:false}`,
 * not a throw), used to fall through to the unconditional
 * `updateRun({confidence:{heldAt:null}})` at the bottom of the route —
 * clearing the hold on work that never left this machine. The
 * worktree branch a few lines above already gets this right: on a
 * failure it early-returns and keeps the hold. This test drives the
 * actual route handler (not a proxy/helper) because the bug lives in
 * its control flow, not in any extracted pure function.
 *
 * Review follow-up: the first fix kept the hold correctly but mislabeled
 * every failure as a push failure ("commit landed but push failed"),
 * even though `autoCommitAndPush` here runs autoCommit+autoPush as one
 * combined step whose result can't be attributed to a specific git
 * sub-step. The second test below pins the corrected, honest wording.
 *
 * Everything I/O-ish except `../meta` is mocked (git ops, app lookup,
 * devops, auth, csrf) — `../meta` is left real so the assertions read
 * the actual on-disk effect of `markMergeNotPushed` / `updateRun`,
 * matching the rigor of `confidenceWorktree.test.ts`'s approach to the
 * sibling worktree path.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { rmSync } from "node:fs";
import { join } from "node:path";

// SESSIONS_DIR is read at module load; point it at a temp dir so this
// test never touches the bridge's live sessions/ folder. vi.hoisted so
// the factory below (hoisted above imports) can see it.
const TMP_SESSIONS = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { mkdtempSync } = require("node:fs") as typeof import("node:fs");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { tmpdir } = require("node:os") as typeof import("node:os");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { join } = require("node:path") as typeof import("node:path");
  return mkdtempSync(join(tmpdir(), "bridge-confidence-ship-"));
});

vi.mock("../paths", async () => {
  const actual = await vi.importActual<typeof import("../paths")>("../paths");
  return { ...actual, SESSIONS_DIR: TMP_SESSIONS };
});

vi.mock("../auth", () => ({
  verifyRequestActor: () => ({
    kind: "operator" as const,
    payload: { sub: "operator@example.com", exp: Number.MAX_SAFE_INTEGER },
  }),
}));

vi.mock("../csrf", () => ({
  checkCsrf: () => ({ ok: true }),
}));

const autoCommitAndPushMock = vi.fn();
vi.mock("../gitOps", () => ({
  autoCommitAndPush: (...args: unknown[]) => autoCommitAndPushMock(...args),
  mergeIntoTargetBranch: vi.fn(),
  readCurrentBranch: vi.fn(),
}));

vi.mock("../devops", () => ({
  runDevopsAgent: vi.fn(),
}));

const APP_PATH = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { mkdtempSync } = require("node:fs") as typeof import("node:fs");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { tmpdir } = require("node:os") as typeof import("node:os");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { join } = require("node:path") as typeof import("node:path");
  return mkdtempSync(join(tmpdir(), "bridge-confidence-ship-app-"));
});

vi.mock("../apps", () => ({
  getApp: () => ({
    name: "real-app",
    path: APP_PATH,
    rawPath: "real-app",
    description: "",
    git: {
      branchMode: "current",
      fixedBranch: "",
      autoCommit: false,
      autoPush: true,
      worktreeMode: "disabled",
      mergeTargetBranch: "",
      integrationMode: "none",
    },
    verify: {},
    pinnedFiles: [],
    symbolDirs: [],
    quality: { critic: false, verifier: true },
    retry: {},
    memory: { distill: false },
    dispatch: {},
    capabilities: [],
  }),
  DEFAULT_GIT_SETTINGS: {
    branchMode: "current",
    fixedBranch: "",
    autoCommit: false,
    autoPush: false,
    worktreeMode: "disabled",
    mergeTargetBranch: "",
    integrationMode: "none",
  },
}));

const TASK_ID = "t_20260826_008";
const SID = "44444444-5555-6666-7777-888888888888";

function taskDir() {
  return join(TMP_SESSIONS, TASK_ID);
}

async function seedHeldRun() {
  const { createMeta, appendRun } = await import("../meta");
  createMeta(taskDir(), {
    taskId: TASK_ID,
    taskTitle: "test task",
    taskBody: "test body",
    taskStatus: "doing",
    taskSection: "DOING",
    taskChecked: false,
    createdAt: "2026-08-26T10:00:00Z",
  });
  await appendRun(taskDir(), {
    sessionId: SID,
    role: "coder",
    repo: "real-app",
    status: "done",
    startedAt: "2026-08-26T10:00:01Z",
    endedAt: "2026-08-26T10:00:02Z",
    confidence: {
      score: 40,
      band: "low",
      heldAt: "2026-08-26T10:00:03Z",
      reviewedBy: null,
    },
  });
}

describe("confidence review route — live-tree ship (H6)", () => {
  beforeEach(() => {
    vi.resetModules();
    autoCommitAndPushMock.mockReset();
  });
  afterEach(() => {
    try { rmSync(taskDir(), { recursive: true, force: true }); } catch { /* ignore */ }
  });

  async function ship() {
    const { POST } = await import(
      "@/app/api/tasks/[id]/runs/[sessionId]/confidence/review/route"
    );
    const req = new Request(
      `http://localhost:7777/api/tasks/${TASK_ID}/runs/${SID}/confidence/review`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "ship" }),
      },
    );
    // NextRequest at runtime is a superset of the Fetch Request the
    // route handler only reads .json()/.method/.headers from — POST's
    // declared param type is NextRequest, this satisfies it structurally.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return POST(req as any, { params: Promise.resolve({ id: TASK_ID, sessionId: SID }) });
  }

  it("keeps the hold and stamps mergeNotPushed when the push is rejected (not a throw)", async () => {
    await seedHeldRun();
    autoCommitAndPushMock.mockResolvedValue({
      ok: false,
      message: "git push failed",
      error: "non-fast-forward",
    });

    const res = await ship();
    expect(res.status).toBe(409);

    const { readMeta } = await import("../meta");
    const run = readMeta(taskDir())?.runs.find((r) => r.sessionId === SID);
    expect(run?.confidence?.heldAt).toBeTruthy();
    expect(run?.mergeNotPushed?.message).toContain("SHIP-INCOMPLETE:");
    expect(run?.mergeNotPushed?.error).toBe("non-fast-forward");
  });

  // Review follow-up: autoCommitAndPush runs autoCommit:true + autoPush:true
  // as ONE combined step here (unlike the worktree branch's push-only call),
  // so a rejected result can equally mean `git add`/`git commit` never
  // landed. The route must not tell the operator "push failed" / "commit
  // landed" for a failure it can't actually attribute to a specific git
  // sub-step — that claim would be wrong exactly as often as the original
  // heldAt-clearing bug was.
  it("does not claim a specific git sub-step failed when the underlying failure is a commit, not a push", async () => {
    await seedHeldRun();
    autoCommitAndPushMock.mockResolvedValue({
      ok: false,
      message: "git commit failed",
      error: "fatal: nothing to commit, working tree clean",
    });

    const res = await ship();
    expect(res.status).toBe(409);
    const body = await res.json();
    // "push" alone (§stage was hardcoded "push" pre-fix) would misreport
    // this specific case, where the underlying git message says "commit".
    expect(body.stage).not.toBe("push");
    expect(body.error).not.toMatch(/push failed/i);

    const { readMeta } = await import("../meta");
    const run = readMeta(taskDir())?.runs.find((r) => r.sessionId === SID);
    expect(run?.confidence?.heldAt).toBeTruthy();
    expect(run?.mergeNotPushed?.message).toContain("SHIP-INCOMPLETE:");
    // The old wording ("commit landed but push failed") is exactly the
    // false claim under test here — assert it's gone.
    expect(run?.mergeNotPushed?.message).not.toMatch(/commit landed/i);
    expect(run?.mergeNotPushed?.message).not.toMatch(/push failed:/i);
    // The real, unattributed git message must still reach the operator.
    expect(run?.mergeNotPushed?.message).toContain("git commit failed");
  });

  it("clears the hold when the push succeeds (control case)", async () => {
    await seedHeldRun();
    autoCommitAndPushMock.mockResolvedValue({ ok: true, message: "pushed" });

    const res = await ship();
    expect(res.status).toBe(200);

    const { readMeta } = await import("../meta");
    const run = readMeta(taskDir())?.runs.find((r) => r.sessionId === SID);
    expect(run?.confidence?.heldAt ?? null).toBeNull();
    expect(run?.mergeNotPushed ?? null).toBeNull();
  });
});
