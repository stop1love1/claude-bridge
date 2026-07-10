/**
 * Fail-loud escalation for QA gates.
 *
 * Two problems this closes:
 *
 *   1. `postExitFlow` (libs/runLifecycle.ts) runs a sequential gate
 *      chain (verify → preflight → claim-vs-diff → style critic →
 *      semantic verifier). When a gate returns "blocked" and no retry
 *      was scheduled (budget exhausted, already a retry, etc.), the
 *      work just sits there — the run row shows the failure but the
 *      TASK section never moves, the operator never gets pinged, and
 *      the only way to notice is to open the UI and go looking.
 *      `escalateGateBlock` closes that gap: it flips the task to
 *      BLOCKED and sends a Telegram ping.
 *
 *   2. Agent-driven gates (style critic, semantic verifier) route
 *      through `runAgentGate` (libs/qualityGate.ts), which resolves
 *      EVERY precondition failure AND every infra failure (spawn
 *      error, timeout, non-JSON verdict) to the same `{ kind:
 *      "skipped" }` outcome. The caller treats `skipped` as "gate
 *      didn't apply" and silently proceeds — which is correct for the
 *      legit preconditions (coordinator role, app not registered,
 *      playbook missing) but wrong for an infra failure, where the
 *      gate SHOULD have run and something broke. `notifyGateInfraSkip`
 *      is the notify-only half for that case — it does not touch the
 *      task section, since an infra hiccup on one gate isn't itself
 *      evidence the shipped work is bad.
 *
 * Both effects in both functions are individually try/caught. This
 * module is called from deep inside `postExitFlow`'s gate chain and
 * must NEVER throw — a notifier hiccup must not stop the pipeline from
 * reporting the actual gate result to the rest of the chain.
 *
 * `updateTask` / `sendTelegramRaw` / `escapeMarkdownV2` are pulled in
 * via a lazy dynamic `import()` (not a static import) because this
 * module is itself imported by both `runLifecycle.ts` and
 * `qualityGate.ts`: a static import of `./telegramNotifier` here would
 * create `runLifecycle.ts → gateEscalation.ts → telegramNotifier.ts →
 * telegramCommands.ts → coordinator.ts → runLifecycle.ts` (coordinator.ts
 * both imports AND re-exports `wireRunLifecycle` from `runLifecycle.ts`).
 * Same category of cycle `coordinatorNudge.ts` already works around by
 * lazy-`require`-ing `./tasksStore`; dynamic `import()` does the same
 * job here and (unlike bare CJS `require`) resolves cleanly under both
 * the Next.js bundler and Vitest/vite-node.
 */
import { logError, logWarn } from "./log";

/** The five post-exit gates that can escalate a hard block. */
export type EscalationGate = "verify" | "preflight" | "claim" | "style" | "semantic";

export interface EscalateGateBlockOptions {
  taskId: string;
  /** Sessions dir for this task (`SESSIONS_DIR/<taskId>`). Carried for
   *  log correlation; the section flip itself resolves its own path via
   *  `updateTask`. */
  sessionsDir: string;
  gate: EscalationGate;
  reason: string;
  /** True when a retry was scheduled for this gate failure — the
   *  pipeline is still self-healing, so no escalation is needed. */
  retryScheduled: boolean;
}

/**
 * Call from a gate's "blocked, no retry scheduled" branch. No-op when
 * `retryScheduled` is true. Otherwise: PATCH the task section to
 * BLOCKED and send a Telegram ping. Each effect is independently
 * try/caught so a notifier outage can't prevent the section flip (or
 * vice versa) — and neither can throw back into the caller.
 */
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
  /** Playbook role / gate label the skip happened under, e.g.
   *  `style-critic` or `semantic-verifier`. Free text, not the closed
   *  `EscalationGate` union — infra skips originate in `qualityGate.ts`,
   *  which is shared by every agent-driven gate role, present and
   *  future. */
  gate: string;
  detail: string;
}

/**
 * Call from `qualityGate.ts` when an agent gate resolves to `skipped`
 * because of an infra failure (spawn error, timeout, missing/non-JSON
 * verdict file) — NOT the legit "playbook absent" / "app not
 * registered" / "coordinator role exempt" skips, which are expected
 * steady-state behavior and stay silent. Notify-only: never throws,
 * never touches the task section.
 */
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
