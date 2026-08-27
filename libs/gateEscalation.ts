import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { logError, logWarn } from "./log";

export type EscalationGate = "verify" | "preflight" | "claim" | "style" | "semantic" | "merge";

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

  try {
    const summaryPath = join(opts.sessionsDir, "summary.md");
    let existing = "";
    try {
      existing = readFileSync(summaryPath, "utf8");
    } catch {
      existing = "";
    }
    const notice = buildGateBlockNotice({ gate: opts.gate, reason: opts.reason });
    const body = existing.trim().length > 0 ? `${notice}\n${existing}` : notice;
    writeFileSync(summaryPath, body, "utf8");
  } catch (e) {
    logError("gate-escalation", "failed to write block notice into summary.md", e, {
      taskId: opts.taskId,
      gate: opts.gate,
    });
  }
}

function buildGateBlockNotice(opts: { gate: EscalationGate; reason: string }): string {
  return [
    `BLOCKED — QA gate \`${opts.gate}\` blocked this task with no retry left: ${opts.reason}`,
    "",
    "The bridge escalated this run instead of continuing: the quality gate above failed and no automatic retry was eligible. The task has been moved to BLOCKED. The summary below (if any) is the coordinator's own report from before the gate fired — it may say the work is ready; the gate found otherwise.",
    "",
    "_Auto-prepended by `libs/gateEscalation.ts` when a QA gate escalated with no retry left._",
    "",
  ].join("\n");
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
