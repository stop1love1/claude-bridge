import type { ChildProcess } from "node:child_process";
import { join } from "node:path";
import { readMeta, updateRun } from "./meta";
import { wireRunLifecycle } from "./runLifecycle";
import { resumeClaude, type ChatSettings } from "./spawn";
import { findTaskBySessionId } from "./tasksStore";
import { SESSIONS_DIR } from "./paths";
import { logError } from "./log";
import { getApp } from "./apps";
import { resolveModelForContinuation } from "./modelResolve";

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
  // Resolved before the spawn, not after, because it feeds the spawn: a
  // continuation re-pins the model its run was started with unless the caller
  // (an operator picking a model in the composer, say) asked for another one.
  // Reads only — findTaskBySessionId/readMeta have no side effects — so
  // hoisting them above resumeClaude changes nothing else.
  const owningTask = findTaskBySessionId(args.sessionId);
  const sessionsDir = owningTask ? join(SESSIONS_DIR, owningTask.id) : null;
  const meta = sessionsDir ? readMeta(sessionsDir) : null;
  const row = meta?.runs.find((r) => r.sessionId === args.sessionId) ?? null;

  const settings = row
    ? {
        ...args.settings,
        model: resolveModelForContinuation({
          requested: args.settings?.model,
          priorModel: row.model ?? null,
          app: getApp(row.repo),
          role: row.role,
          taskModel: meta?.taskModel ?? null,
        }),
      }
    : args.settings;

  const child = resumeClaude(
    args.cwd,
    args.sessionId,
    args.message,
    settings,
    args.settingsPath,
  );

  if (!owningTask || !sessionsDir || !row) return child;

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
