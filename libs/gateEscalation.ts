import { logError, logWarn } from "./log";

export type EscalationGate = "verify" | "preflight" | "claim" | "style" | "semantic";

export interface EscalateGateBlockOptions {
  taskId: string;
  sessionsDir: string;
  gate: EscalationGate;
  reason: string;
  retryScheduled: boolean;
}

export async function escalateGateBlock(
  opts: EscalateGateBlockOptions,
): Promise<void> {
  if (opts.retryScheduled) return;

  try {
    const { updateTask } = await import("./tasksStore");
    await updateTask(opts.taskId, { section: "BLOCKED" });
  } catch (e) {
    logError("gate-escalation", "failed to PATCH task section to BLOCKED", e, {
      taskId: opts.taskId,
      sessionsDir: opts.sessionsDir,
      gate: opts.gate,
    });
  }

  try {
    const { sendTelegramRaw, escapeMarkdownV2 } = await import("./telegramNotifier");
    await sendTelegramRaw(
      `🚨 QA gate ${escapeMarkdownV2(opts.gate)} blocked ${escapeMarkdownV2(opts.taskId)} with no retry left: ${escapeMarkdownV2(opts.reason)}`,
    );
  } catch (e) {
    logError("gate-escalation", "failed to send Telegram block notice", e, {
      taskId: opts.taskId,
      gate: opts.gate,
    });
  }
}

export interface NotifyGateInfraSkipOptions {
  taskId: string;
  gate: string;
  detail: string;
}

export async function notifyGateInfraSkip(
  opts: NotifyGateInfraSkipOptions,
): Promise<void> {
  try {
    const { sendTelegramRaw, escapeMarkdownV2 } = await import("./telegramNotifier");
    await sendTelegramRaw(
      `⚠️ QA gate ${escapeMarkdownV2(opts.gate)} skipped for ${escapeMarkdownV2(opts.taskId)} \\(infra\\): ${escapeMarkdownV2(opts.detail)}`,
    );
  } catch (e) {
    logWarn("gate-escalation", "failed to send Telegram infra-skip notice", {
      taskId: opts.taskId,
      gate: opts.gate,
      error: (e as Error).message,
    });
  }
}
