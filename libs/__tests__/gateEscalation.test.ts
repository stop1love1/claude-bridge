import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function mktmp(): string {
  return mkdtempSync(join(tmpdir(), "bridge-gateescalation-"));
}

const sendTelegramRaw = vi.fn().mockResolvedValue(undefined);

vi.mock("../telegramNotifier", () => ({
  sendTelegramRaw: (text: string) => sendTelegramRaw(text),
  escapeMarkdownV2: (s: string) => s,
}));

const TASK_ID = "t_20260710_001";
const TASK_HEADER = {
  taskId: TASK_ID,
  taskTitle: "test task",
  taskBody: "test body",
  taskStatus: "doing" as const,
  taskSection: "DOING" as const,
  taskChecked: false,
  createdAt: "2026-07-10T10:00:00Z",
};

describe("escalateGateBlock", () => {
  let tmpRoot: string;
  let dir: string;

  beforeEach(() => {
    tmpRoot = mktmp();
    dir = join(tmpRoot, "sessions", TASK_ID);
    vi.spyOn(process, "cwd").mockReturnValue(tmpRoot);
    vi.resetModules();
    sendTelegramRaw.mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("flips the task section to BLOCKED and notifies when retryScheduled is false", async () => {
    const { createMeta, readMeta } = await import("../meta");
    const { escalateGateBlock } = await import("../gateEscalation");
    createMeta(dir, TASK_HEADER);

    await escalateGateBlock({
      taskId: TASK_ID,
      sessionsDir: dir,
      gate: "verify",
      reason: "chain crashed — inconclusive",
      retryScheduled: false,
    });

    const meta = readMeta(dir);
    expect(meta?.taskSection).toBe("BLOCKED");
    expect(sendTelegramRaw).toHaveBeenCalledTimes(1);
    const [text] = sendTelegramRaw.mock.calls[0];
    expect(text).toContain("verify");
    expect(text).toContain(TASK_ID);
    expect(text).toContain("chain crashed — inconclusive");
    expect(text).toContain("no retry left");
  });

  it("does NOT flip the section or notify when retryScheduled is true", async () => {
    const { createMeta, readMeta } = await import("../meta");
    const { escalateGateBlock } = await import("../gateEscalation");
    createMeta(dir, TASK_HEADER);

    await escalateGateBlock({
      taskId: TASK_ID,
      sessionsDir: dir,
      gate: "style",
      reason: "alien — spawned retry",
      retryScheduled: true,
    });

    const meta = readMeta(dir);
    expect(meta?.taskSection).toBe("DOING");
    expect(sendTelegramRaw).not.toHaveBeenCalled();
  });

  it("still flips the section to BLOCKED even when the notify call rejects", async () => {
    sendTelegramRaw.mockRejectedValueOnce(new Error("telegram down"));
    const { createMeta, readMeta } = await import("../meta");
    const { escalateGateBlock } = await import("../gateEscalation");
    createMeta(dir, TASK_HEADER);

    await expect(
      escalateGateBlock({
        taskId: TASK_ID,
        sessionsDir: dir,
        gate: "semantic",
        reason: "broken — retry ineligible",
        retryScheduled: false,
      }),
    ).resolves.toBeUndefined();

    const meta = readMeta(dir);
    expect(meta?.taskSection).toBe("BLOCKED");
  });

  it("never throws even when the task doesn't exist (updateTask returns null)", async () => {
    const { escalateGateBlock } = await import("../gateEscalation");
    await expect(
      escalateGateBlock({
        taskId: TASK_ID,
        sessionsDir: dir,
        gate: "claim",
        reason: "drift — retry ineligible",
        retryScheduled: false,
      }),
    ).resolves.toBeUndefined();
    expect(sendTelegramRaw).toHaveBeenCalledTimes(1);
  });
});

describe("notifyGateInfraSkip", () => {
  beforeEach(() => {
    sendTelegramRaw.mockClear();
  });

  it("calls notify with the gate name and detail", async () => {
    const { notifyGateInfraSkip } = await import("../gateEscalation");
    await notifyGateInfraSkip({
      taskId: TASK_ID,
      gate: "style-critic",
      detail: "style-critic spawn failed: ENOENT",
    });

    expect(sendTelegramRaw).toHaveBeenCalledTimes(1);
    const [text] = sendTelegramRaw.mock.calls[0];
    expect(text).toContain("style-critic");
    expect(text).toContain(TASK_ID);
    expect(text).toContain("style-critic spawn failed: ENOENT");
  });

  it("never throws when notify rejects", async () => {
    sendTelegramRaw.mockRejectedValueOnce(new Error("telegram down"));
    const { notifyGateInfraSkip } = await import("../gateEscalation");
    await expect(
      notifyGateInfraSkip({
        taskId: TASK_ID,
        gate: "semantic-verifier",
        detail: "timed out after 600000ms",
      }),
    ).resolves.toBeUndefined();
  });
});
