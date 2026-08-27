import { join } from "node:path";
import { existsSync } from "node:fs";
import { getApp } from "./apps";
import { readMeta, updateRun, type Run } from "./meta";
import { wireRunLifecycle } from "./coordinator";
import { resolveRepoCwd } from "./repos";
import { denyTaskToolArgs, resumeClaude } from "./spawn";
import { acquireRepoReservation, releaseRepoReservation } from "./repoReservation";
import { freeSessionSettingsPath, writeSessionSettings } from "./permissionSettings";
import { BRIDGE_ROOT, SESSIONS_DIR, readBridgeMd } from "./paths";
import {
  checkEligibility,
  maxAttemptsFor,
  nextRetryRole,
  parseRole,
  renderStrategyPrefix,
  type RetryGate,
} from "./retryLadder";

export interface SpawnRetryArgs {
  taskId: string;
  finishedRun: Run;
  gate: RetryGate;
  ctxBlock: string;
  logLabel: string;
  precomputedAttempt?: { nextAttempt: number };
}

export async function spawnRetry(
  args: SpawnRetryArgs,
): Promise<{ sessionId: string; run: Run } | null> {
  const {
    taskId,
    finishedRun,
    gate,
    ctxBlock,
    logLabel,
    precomputedAttempt,
  } = args;

  const sessionsDir = join(SESSIONS_DIR, taskId);

  const md = readBridgeMd();
  const liveRepoCwd = resolveRepoCwd(md, BRIDGE_ROOT, finishedRun.repo);
  if (!liveRepoCwd) return null;
  let spawnCwd = liveRepoCwd;
  if (finishedRun.worktreePath && existsSync(finishedRun.worktreePath)) {
    spawnCwd = finishedRun.worktreePath;
  }

  const app = getApp(finishedRun.repo);

  let nextAttempt: number;
  if (precomputedAttempt) {
    nextAttempt = precomputedAttempt.nextAttempt;
  } else {
    const meta = readMeta(sessionsDir);
    if (!meta) return null;
    const elig = checkEligibility({ finishedRun, meta, gate, retry: app?.retry });
    if (!elig.eligible) return null;
    nextAttempt = elig.nextAttempt;
  }

  const parsed = parseRole(finishedRun.role);
  const maxAttempts = maxAttemptsFor(app?.retry, gate);
  const strategyPrefix = renderStrategyPrefix({ gate, attempt: nextAttempt, maxAttempts });

  const retryMessage = [strategyPrefix, ctxBlock].join("\n");

  const sessionId = finishedRun.sessionId;

  const nextRole = nextRetryRole(parsed.baseRole, gate, nextAttempt);
  try {
    const updateResult = await updateRun(
      sessionsDir,
      sessionId,
      {
        role: nextRole,
        status: "running",
        startedAt: new Date().toISOString(),
        endedAt: null,
        retryAttempt: nextAttempt,
      },
      (liveRun, liveMeta) => {
        if (liveRun.status === "running") return false;
        const elig = checkEligibility({
          finishedRun: liveRun,
          meta: liveMeta,
          gate,
          retry: app?.retry,
        });
        return elig.eligible && elig.nextAttempt === nextAttempt;
      },
    );
    if (!updateResult.applied || !updateResult.run) {
      console.error(
        `${logLabel} retry not applied (budget raced or precondition failed) for`,
        taskId,
        sessionId,
      );
      return null;
    }
  } catch (e) {
    console.error(`${logLabel} meta updateRun failed for`, taskId, sessionId, e);
    return null;
  }

  if (app && !finishedRun.worktreePath) {
    const reservation = acquireRepoReservation(finishedRun.repo, sessionId);
    if (!reservation.ok) {
      console.warn(
        `${logLabel} could not reserve ${finishedRun.repo} for retry (held by ${reservation.heldBy}) — proceeding anyway`,
        taskId,
        sessionId,
      );
    }
  }

  let child;
  try {
    const settingsPath = writeSessionSettings(freeSessionSettingsPath(sessionId));
    child = resumeClaude(
      spawnCwd,
      sessionId,
      retryMessage,
      { mode: "bypassPermissions", disallowedTools: denyTaskToolArgs() },
      settingsPath,
    );
  } catch (e) {
    console.error(`${logLabel} resume failed for`, taskId, sessionId, e);
    try {
      await updateRun(sessionsDir, sessionId, {
        status: "failed",
        endedAt: new Date().toISOString(),
      });
    } catch {
    }
    releaseRepoReservation(finishedRun.repo, sessionId);
    return null;
  }

  const refreshedMeta = readMeta(sessionsDir);
  const retryRun = refreshedMeta?.runs.find((r) => r.sessionId === sessionId);
  if (!retryRun) {
    console.error(
      `${logLabel} resumed run vanished from meta for`,
      taskId,
      sessionId,
    );
    releaseRepoReservation(finishedRun.repo, sessionId);
    return null;
  }

  wireRunLifecycle(
    sessionsDir,
    sessionId,
    child,
    finishedRun.repo,
    `${logLabel} ${taskId}/${sessionId}`,
  );
  return { sessionId, run: retryRun };
}
