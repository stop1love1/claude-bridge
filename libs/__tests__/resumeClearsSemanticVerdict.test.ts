import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Real `../meta` — the point of this file is what actually lands on the run row
// after a resume, not what patch object was handed to a mock.
let sessionsRoot = "";

vi.mock("../paths", () => ({
  get SESSIONS_DIR() {
    return sessionsRoot;
  },
}));

const fakeChild = { on: () => { }, once: () => { } } as unknown as ChildProcess;
vi.mock("../spawn", () => ({ resumeClaude: () => fakeChild }));
vi.mock("../runLifecycle", () => ({ wireRunLifecycle: () => undefined }));

const TASK_ID = "t_20260905_777";
const SID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
vi.mock("../tasksStore", () => ({
  findTaskBySessionId: () => ({ id: TASK_ID }),
}));

const TASK_HEADER = {
  taskId: TASK_ID,
  taskTitle: "resume clears semantic verdict",
  taskBody: "test body",
  taskStatus: "doing" as const,
  taskSection: "DOING" as const,
  taskChecked: false,
  createdAt: "2026-09-05T09:00:00Z",
};

const PASS_SEMANTIC = {
  verdict: "pass" as const,
  reason: "the panel judged the PREVIOUS exit's diff",
  concerns: [],
  durationMs: 1,
};

let dir = "";

beforeEach(() => {
  sessionsRoot = mkdtempSync(join(tmpdir(), "bridge-resume-"));
  dir = join(sessionsRoot, TASK_ID);
  vi.resetModules();
});

afterEach(() => {
  try { rmSync(sessionsRoot, { recursive: true, force: true }); } catch { }
});

async function seedRunWithSemanticVerdict(): Promise<typeof import("../meta")> {
  const meta = await import("../meta");
  meta.createMeta(dir, TASK_HEADER);
  await meta.appendRun(dir, {
    sessionId: SID,
    role: "coder",
    repo: "real-app",
    status: "done",
    startedAt: "2026-09-05T10:00:00Z",
    endedAt: "2026-09-05T10:05:00Z",
    semanticVerifier: PASS_SEMANTIC,
  });
  return meta;
}

describe("resumeSessionWithLifecycle clears the recorded semantic verdict", () => {
  // A resumed run writes NEW code under the SAME run row. Leaving the old
  // verdict there let the gate's idempotency guard replay a `pass` as a skip,
  // so the bridge auto-committed a diff no panel ever judged.
  it("drops the recorded `pass` verdict from the row it resumes", async () => {
    const meta = await seedRunWithSemanticVerdict();
    expect(meta.readMeta(dir)?.runs[0].semanticVerifier).toEqual(PASS_SEMANTIC);

    const { resumeSessionWithLifecycle } = await import("../resumeSession");
    resumeSessionWithLifecycle({
      cwd: "/tmp/bridge",
      sessionId: SID,
      message: "please fix the thing",
    });
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    const row = meta.readMeta(dir)?.runs.find((r) => r.sessionId === SID);
    expect(row?.status).toBe("running");
    expect(row?.semanticVerifier).toBeFalsy();
    // What the gate reads: no verdict to replay, so it must re-run the panel.
    expect(row?.semanticVerifier?.verdict).toBeUndefined();
  });

  // Only the semantic gate is cleared this round — verify / claim / style carry
  // different retry semantics and none of them has a replay guard.
  it("leaves the other gate results on the row untouched", async () => {
    const meta = await import("../meta");
    meta.createMeta(dir, TASK_HEADER);
    const styleCritic = {
      verdict: "match" as const,
      reason: "fits the house style",
      issues: [],
      durationMs: 1,
    };
    await meta.appendRun(dir, {
      sessionId: SID,
      role: "coder",
      repo: "real-app",
      status: "done",
      startedAt: "2026-09-05T10:00:00Z",
      endedAt: "2026-09-05T10:05:00Z",
      semanticVerifier: PASS_SEMANTIC,
      styleCritic,
    });

    const { resumeSessionWithLifecycle } = await import("../resumeSession");
    resumeSessionWithLifecycle({
      cwd: "/tmp/bridge",
      sessionId: SID,
      message: "please fix the thing",
    });
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    const row = meta.readMeta(dir)?.runs.find((r) => r.sessionId === SID);
    expect(row?.semanticVerifier).toBeFalsy();
    expect(row?.styleCritic).toEqual(styleCritic);
  });
});
