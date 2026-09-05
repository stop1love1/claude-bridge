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
  if (!row) return child;

  void updateRun(sessionsDir, args.sessionId, {
    status: "running",
    startedAt: new Date().toISOString(),
    endedAt: null,
    // A resumed run writes NEW code under the same run row, so the semantic
    // verdict recorded for the previous exit no longer describes the diff the
    // next post-exit flow will commit. Clear it here — every resume path goes
    // through this function — so the gate always re-judges instead of
    // replaying a stale `pass`/`drift` as a skip.
    semanticVerifier: null,
  }).catch((e) =>
    logError("resume-session", "status flip failed", e, {
      tag: `${owningTask.id}/${args.sessionId.slice(0, 8)}`,
    }),
  );

  wireRunLifecycle(
    sessionsDir,
    args.sessionId,
    child,
    row.repo,
    args.context ?? `resume ${owningTask.id}/${args.sessionId.slice(0, 8)}`,
  );

  return child;
}
