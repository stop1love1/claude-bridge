import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { IntakeRecord } from "../planGate";

/**
 * Telegram plan-gate approval commands (`/plan`, `/approve`, `/replan`)
 * plus the "plan awaiting approval" notifier ping.
 *
 * Follows the chdir + resetModules + dynamic-import convention used by
 * `telegramSummary.test.ts` / `metaIntake.test.ts`: `libs/paths.ts`
 * captures `SESSIONS_DIR` from `process.cwd()` at module load, so each
 * test needs a fresh module graph pointed at its own temp "bridge root".
 *
 * `continueCoordinator` is mocked so these tests never touch the real
 * coordinator spawn / resume machinery — only the plan-gate state
 * machine (mirrors `app/api/tasks/[id]/plan/approve/route.ts`) is under
 * test here.
 */

vi.mock("../planGateLifecycle", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../planGateLifecycle")>();
  return {
    ...actual,
    continueCoordinator: vi.fn().mockResolvedValue(undefined),
  };
});

const TASK_ID = "t_20260710_001";

let tempRoot: string;
let originalCwd: string;

beforeEach(() => {
  originalCwd = process.cwd();
  tempRoot = mkdtempSync(join(tmpdir(), "bridge-tg-plan-"));
  process.chdir(tempRoot);
  vi.resetModules();
  // The mocked `continueCoordinator` is created once inside the
  // `vi.mock` factory and reused across `resetModules()` cycles (only
  // the module *cache* is cleared, not the mock fn's call history) —
  // clear it per-test so assertions don't see calls from prior tests.
  vi.clearAllMocks();
});

afterEach(() => {
  process.chdir(originalCwd);
  vi.resetModules();
  try {
    rmSync(tempRoot, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

/**
 * Create a task's meta.json under the temp sessions dir, optionally
 * patching its intake record. Returns the task's sessions dir.
 */
async function makeTask(intakePatch?: Partial<IntakeRecord>): Promise<string> {
  const { createMeta, setIntake } = await import("../meta");
  const dir = join(tempRoot, "sessions", TASK_ID);
  createMeta(dir, {
    taskId: TASK_ID,
    taskTitle: "Test task",
    taskBody: "body",
    taskStatus: "doing",
    taskSection: "DOING",
    taskChecked: false,
    createdAt: new Date().toISOString(),
  });
  if (intakePatch) await setIntake(dir, intakePatch);
  return dir;
}

async function resetPlanGateConfig(): Promise<void> {
  const { _resetForTests } = await import("../planGateConfig");
  _resetForTests();
}

describe("commandPlanShow", () => {
  it("returns text containing the intake status and summary", async () => {
    await resetPlanGateConfig();
    await makeTask({ status: "awaiting-approval", summary: "plan summary" });
    const { commandPlanShow } = await import("../telegramCommands");
    const out = await commandPlanShow(TASK_ID);
    expect(out).toContain("awaiting-approval");
    expect(out).toContain("plan summary");
  });

  it("returns a 'no plan' message when intake.status is none", async () => {
    await resetPlanGateConfig();
    await makeTask();
    const { commandPlanShow } = await import("../telegramCommands");
    const out = await commandPlanShow(TASK_ID);
    expect(out).toMatch(/no plan to act on/i);
  });

  it("returns usage when no id given", async () => {
    const { commandPlanShow } = await import("../telegramCommands");
    expect(await commandPlanShow(undefined)).toMatch(/Usage:/);
  });

  it("rejects an invalid task id", async () => {
    const { commandPlanShow } = await import("../telegramCommands");
    expect(await commandPlanShow("not-an-id")).toMatch(/Invalid task id/);
  });

  it("reports task not found for an unknown id", async () => {
    const { commandPlanShow } = await import("../telegramCommands");
    expect(await commandPlanShow("t_20260710_999")).toMatch(/not found/i);
  });
});

describe("commandPlanApprove", () => {
  it("flips intake to approved and returns a checkmark message", async () => {
    await resetPlanGateConfig();
    const dir = await makeTask({ status: "awaiting-approval", summary: "plan summary" });
    const { commandPlanApprove } = await import("../telegramCommands");
    const { readIntake } = await import("../meta");
    const out = await commandPlanApprove(TASK_ID);
    expect(out).toContain("✅");
    const intake = readIntake(dir);
    expect(intake?.status).toBe("approved");
    expect(intake?.approvedBy).toEqual(
      expect.objectContaining({ kind: "operator", label: "telegram" }),
    );
  });

  it("second call is idempotent", async () => {
    await resetPlanGateConfig();
    await makeTask({ status: "awaiting-approval", summary: "plan summary" });
    const { commandPlanApprove } = await import("../telegramCommands");
    await commandPlanApprove(TASK_ID);
    const out = await commandPlanApprove(TASK_ID);
    expect(out.toLowerCase()).toContain("already approved");
  });

  it("returns 'no plan to act on' when intake.status is none", async () => {
    await resetPlanGateConfig();
    await makeTask();
    const { commandPlanApprove } = await import("../telegramCommands");
    const out = await commandPlanApprove(TASK_ID);
    expect(out).toMatch(/no plan to act on/i);
  });

  it("calls continueCoordinator WITHOUT the replan flag", async () => {
    await resetPlanGateConfig();
    const dir = await makeTask({ status: "awaiting-approval", summary: "plan summary" });
    const { commandPlanApprove } = await import("../telegramCommands");
    const { continueCoordinator } = await import("../planGateLifecycle");
    await commandPlanApprove(TASK_ID);
    expect(continueCoordinator).toHaveBeenCalledWith(TASK_ID, dir, "plan summary");
  });
});

describe("commandPlanReplan", () => {
  it("returns the cap message and does NOT bump rounds when rounds >= maxClarifyRounds", async () => {
    await resetPlanGateConfig();
    const dir = await makeTask({ status: "awaiting-approval", rounds: 3 });
    const { commandPlanReplan } = await import("../telegramCommands");
    const { readIntake } = await import("../meta");
    const out = await commandPlanReplan(TASK_ID, "please address X");
    expect(out).toMatch(/capped at 3/i);
    const intake = readIntake(dir);
    expect(intake?.rounds).toBe(3);
    expect(intake?.status).toBe("awaiting-approval");
  });

  it("flips status to planning and bumps rounds under the cap", async () => {
    await resetPlanGateConfig();
    const dir = await makeTask({ status: "awaiting-approval", rounds: 0 });
    const { commandPlanReplan } = await import("../telegramCommands");
    const { readIntake } = await import("../meta");
    await commandPlanReplan(TASK_ID, "please address X");
    const intake = readIntake(dir);
    expect(intake?.status).toBe("planning");
    expect(intake?.rounds).toBe(1);
  });

  it("calls continueCoordinator WITH {replan:true}", async () => {
    await resetPlanGateConfig();
    const dir = await makeTask({ status: "awaiting-approval", rounds: 0 });
    const { commandPlanReplan } = await import("../telegramCommands");
    const { continueCoordinator } = await import("../planGateLifecycle");
    await commandPlanReplan(TASK_ID, "please address X");
    expect(continueCoordinator).toHaveBeenCalledWith(
      TASK_ID,
      dir,
      expect.stringContaining("please address X"),
      { replan: true },
    );
  });

  it("returns 'no plan to act on' when intake.status is none", async () => {
    await resetPlanGateConfig();
    await makeTask();
    const { commandPlanReplan } = await import("../telegramCommands");
    const out = await commandPlanReplan(TASK_ID, "please address X");
    expect(out).toMatch(/no plan to act on/i);
  });

  it("returns usage when the note is missing", async () => {
    await resetPlanGateConfig();
    await makeTask({ status: "awaiting-approval" });
    const { commandPlanReplan } = await import("../telegramCommands");
    const out = await commandPlanReplan(TASK_ID, undefined);
    expect(out).toMatch(/Usage:/);
  });
});

describe("/plan /approve /replan wired into dispatchCommand", () => {
  it("routes '/plan <id>' through the COMMANDS registry", async () => {
    await resetPlanGateConfig();
    await makeTask({ status: "awaiting-approval", summary: "plan summary" });
    const { dispatchCommand } = await import("../telegramCommands");
    const out = await dispatchCommand(`/plan ${TASK_ID}`);
    expect(out).toContain("awaiting-approval");
  });

  it("routes '/replan <id> <note>' preserving a multi-word note", async () => {
    await resetPlanGateConfig();
    const dir = await makeTask({ status: "awaiting-approval", rounds: 0 });
    const { dispatchCommand } = await import("../telegramCommands");
    const { continueCoordinator } = await import("../planGateLifecycle");
    await dispatchCommand(`/replan ${TASK_ID} please fix the auth flow`);
    expect(continueCoordinator).toHaveBeenCalledWith(
      TASK_ID,
      dir,
      expect.stringContaining("please fix the auth flow"),
      { replan: true },
    );
  });
});

describe("plan-gate awaiting-approval notification hook", () => {
  it("emits an intake-awaiting-approval meta event (with taskTitle) when the planner leaves a needs-decision verdict", async () => {
    const dir = await makeTask({ status: "planning" });
    writeFileSync(
      join(dir, "intake.json"),
      JSON.stringify({
        verdict: "needs-decision",
        summary: "clarify auth",
        questions: [{ id: "q1", text: "pick an auth provider" }],
      }),
    );
    const { subscribeMetaAll } = await import("../meta");
    const { resolvePlanGateAfterPlanner } = await import("../planGateLifecycle");
    const events: Array<{ kind: string; taskId: string; taskTitle?: string }> = [];
    const unsubscribe = subscribeMetaAll((ev) => events.push(ev));
    try {
      await resolvePlanGateAfterPlanner({
        taskId: TASK_ID,
        sessionsDir: dir,
        plannerSessionId: "sess_1",
      });
    } finally {
      unsubscribe();
    }
    const ev = events.find((e) => e.kind === "intake-awaiting-approval");
    expect(ev).toBeTruthy();
    expect(ev?.taskId).toBe(TASK_ID);
    expect(ev?.taskTitle).toBe("Test task");
  });

  // NOTE: the "verdict=clear + submitter can self-approve" branch is
  // deliberately NOT exercised here — it drives `continueCoordinator`
  // down the REAL (non-mocked) path, because `resolvePlanGateAfterPlanner`
  // is spread from `importOriginal()` and its internal call to
  // `continueCoordinator` binds directly to the module's own local
  // function rather than the mocked export (an inherent limitation of
  // partial `vi.mock(..., { ...actual })` on same-module self-calls).
  // That path is already covered by `planGateLifecycle.test.ts`
  // (`computeNextIntakeStatus`) and the approve route's own tests; this
  // suite only needs to prove the awaiting-approval branch emits.
});

describe("renderPlanAwaitingApprovalMessage", () => {
  it("includes the title and the three plan-gate commands with the task id", async () => {
    const { renderPlanAwaitingApprovalMessage } = await import("../telegramNotifier");
    const out = renderPlanAwaitingApprovalMessage({
      taskId: TASK_ID,
      taskTitle: "Ship checkout",
    });
    expect(out).toContain("Plan ready for review");
    expect(out).toContain("Ship checkout");
    expect(out).toContain("/plan");
    expect(out).toContain("/approve");
    expect(out).toContain("/replan");
    expect(out).toContain("<note>");
  });
});
