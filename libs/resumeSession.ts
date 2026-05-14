/**
 * Centralized "resume + wire lifecycle" helper for paths that re-attach
 * to an existing Claude session via `claude --resume`.
 *
 * Why this exists: the bridge had three `resumeClaude(...)` callsites
 * outside `agents/route.ts` (continue, sessions/message, …) that all
 * fired the resume but skipped the meta-status flip + lifecycle wire.
 * Symptom: meta.json said `done` while a fresh claude process was
 * actively responding — the UI's "responding…" indicator (sourced from
 * `sessionEvents.alive`) and the run-row badge (sourced from meta) ended
 * up disagreeing. The agents-route resume path got it right; the others
 * didn't. Centralizing the right shape here closes the gap.
 *
 * Behavior:
 *   1. `resumeClaude` spawns the new one-shot subprocess and registers
 *      it for kill / liveness tracking.
 *   2. If the sessionId belongs to a known task (`findTaskBySessionId`
 *      hits), we flip the run row `done|failed → running`, clear
 *      `endedAt`, stamp a fresh `startedAt`, and wire `wireRunLifecycle`
 *      so the new process's exit transitions the row back to
 *      `done|failed` cleanly.
 *   3. If the sessionId has no task (free chat session), we skip the
 *      meta wiring entirely and just return the child — same shape as
 *      the legacy direct `resumeClaude` call.
 *
 * Status-flip + wire are best-effort: a failure logs and falls through
 * — the resume itself already succeeded and the session will keep
 * working, just with a stale-looking meta row until the next event.
 */
import type { ChildProcess } from "node:child_process";
import { join } from "node:path";
import { readMeta, updateRun } from "./meta";
import { wireRunLifecycle } from "./runLifecycle";
import { resumeClaude, type ChatSettings } from "./spawn";
import { findTaskBySessionId } from "./tasksStore";
import { SESSIONS_DIR } from "./paths";
import { logError } from "./log";

export interface ResumeWithLifecycleArgs {
  cwd: string;
  sessionId: string;
  message: string;
  settings?: ChatSettings;
  settingsPath?: string;
  /** Tag used in lifecycle log lines (defaults to `resume <taskId>/<sid>`). */
  context?: string;
}

export function resumeSessionWithLifecycle(
  args: ResumeWithLifecycleArgs,
): ChildProcess {
  const child = resumeClaude(
    args.cwd,
    args.sessionId,
    args.message,
    args.settings,
    args.settingsPath,
  );

  const owningTask = findTaskBySessionId(args.sessionId);
  if (!owningTask) return child;

  const sessionsDir = join(SESSIONS_DIR, owningTask.id);
  const meta = readMeta(sessionsDir);
  const row = meta?.runs.find((r) => r.sessionId === args.sessionId);
  // Defensive: only flip status / wire lifecycle when there's a row to
  // mutate. Without this guard a stale sessionId index entry could push
  // a phantom-running row onto a meta that doesn't have it.
  if (!row) return child;

  void updateRun(sessionsDir, args.sessionId, {
    status: "running",
    startedAt: new Date().toISOString(),
    endedAt: null,
  }).catch((e) =>
    logError("resume-session", "status flip failed", e, {
      tag: `${owningTask.id}/${args.sessionId.slice(0, 8)}`,
    }),
  );

  wireRunLifecycle(
    sessionsDir,
    args.sessionId,
    child,
    args.context ?? `resume ${owningTask.id}/${args.sessionId.slice(0, 8)}`,
  );

  return child;
}
