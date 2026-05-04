/**
 * Shared retry-spawn primitive.
 *
 * Five different gates retry a failed/finished child after the bridge
 * detects something wrong with the original turn:
 *
 *   - `crash`     — childRetry.ts after a `failed` exit
 *   - `verify`    — verifyChain.ts after a `verify` step failed
 *   - `preflight` — preflightCheck.ts after preflight rejected the run
 *   - `claim`     — verifier.ts after the LLM claim-checker rejected
 *   - `style`     — styleCritic.ts after the style critic rejected
 *
 * **Reuse-by-resume:** the retry continues the original child's Claude
 * session via `claude --resume <prior-sid>` instead of starting a brand-
 * new one. The agent already has the full transcript (system prompt,
 * task body, repo context, every file it read, every tool call) in its
 * `.jsonl`; the retry only needs to send the new user turn — the
 * strategy prefix + the gate-specific failure context. Saves the cost
 * of re-injecting the entire child wrapper (16 KB+ of boilerplate)
 * AND the time of re-exploring the codebase.
 *
 * Same-row tracking: meta.json keeps ONE Run per (parent, baseRole,
 * repo) chain that mutates across attempts — the same way the
 * coordinator-driven `mode:"resume"` path in agents/route.ts works.
 * The role suffix walks via `nextRetryRole`; the `retryAttempt` field
 * counts the attempt; status flips back to `running`. AgentTree reads
 * the role suffix to render the correct chip ("coder-cretry"); past
 * attempts live in the `.jsonl` transcript, which is the durable
 * record.
 */
import { join } from "node:path";
import { existsSync } from "node:fs";
import { getApp } from "./apps";
import { readMeta, updateRun, type Run } from "./meta";
import { wireRunLifecycle } from "./coordinator";
import { resolveRepoCwd } from "./repos";
import { resumeClaude } from "./spawn";
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
  /** Run that just finished — its session id, role, parent, worktree are reused. */
  finishedRun: Run;
  /** Which gate triggered the retry. Drives eligibility + role suffix. */
  gate: RetryGate;
  /**
   * Pre-rendered failure-context block. Sent to the resumed agent as
   * the new user turn. Caller is responsible for the gate-specific
   * content (verify steps, claim diff, preflight findings, …).
   */
  ctxBlock: string;
  /**
   * Short log tag. Used in console.error / wireRunLifecycle so an
   * operator scrolling logs can tell crash-retries from verify-retries
   * at a glance.
   */
  logLabel: string;
  /**
   * Optional seam for callers that have already computed eligibility and
   * want to pass the attempt number through (avoids a redundant
   * `readMeta` + `checkEligibility` round-trip). When omitted we
   * derive it here, same as the inline copies did.
   */
  precomputedAttempt?: { nextAttempt: number };
}

/**
 * Resume `finishedRun` for another attempt at the same gate. Reuses
 * the original Claude session via `claude --resume <sid>` so the agent
 * keeps its full transcript (no re-injection of the child wrapper, no
 * re-exploration of the codebase). Returns the mutated `Run` on
 * success, or `null` when:
 *   - the repo can't be resolved (renamed / deleted)
 *   - meta.json is missing for the task
 *   - the retry budget is exhausted
 *   - `resumeClaude` itself throws (claude binary missing, EAGAIN, …)
 *
 * Same-row mutation: the existing meta row's `role` walks to the next
 * gate suffix, `status` flips back to `running`, `startedAt` refreshes,
 * `endedAt` clears, `retryAttempt` records the new attempt number. No
 * new row is appended; the AgentTree just re-renders the same node.
 *
 * Always non-throwing — caller doesn't need a try/catch.
 */
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
  // Resume reuses the prior worktree when it still exists on disk
  // (failure path that didn't run cleanup, or worktree mode + no
  // post-exit merge yet); otherwise the live tree typically holds the
  // merged result of the prior turn. Mirrors handleResume in the
  // agents API route so coordinator-driven and bridge-driven resumes
  // behave the same.
  let spawnCwd = liveRepoCwd;
  if (finishedRun.worktreePath && existsSync(finishedRun.worktreePath)) {
    spawnCwd = finishedRun.worktreePath;
  }

  const app = getApp(finishedRun.repo);

  // Re-derive eligibility at spawn time so a concurrent spawn that
  // raced us past the budget bails here rather than producing an
  // orphan Run record.
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

  // The resumed agent already has the original brief and the prior
  // turn's tool calls in its `.jsonl`. The new user turn is JUST the
  // strategy prefix + the failure-context block — no original prompt
  // re-injection, no body fallback. This is the entire point of the
  // reuse path: skip the re-load.
  const retryMessage = [strategyPrefix, ctxBlock].join("\n");

  // Reuse the prior session id — `claude --resume <sid>` extends the
  // same transcript file. The meta row mutates in place; no new row
  // is appended.
  const sessionId = finishedRun.sessionId;
  const settingsPath = writeSessionSettings(freeSessionSettingsPath(sessionId));

  // Flip the existing run row back to running BEFORE the spawn so the
  // UI shows progress immediately and the lifecycle hook sees the row
  // in `running` when it eventually fires `done` / `failed`. The role
  // walks to the next retry suffix; retryAttempt records which attempt
  // this is.
  const nextRole = nextRetryRole(parsed.baseRole, gate, nextAttempt);
  try {
    const updateResult = await updateRun(sessionsDir, sessionId, {
      role: nextRole,
      status: "running",
      startedAt: new Date().toISOString(),
      endedAt: null,
      retryAttempt: nextAttempt,
    });
    if (!updateResult.applied || !updateResult.run) {
      console.error(
        `${logLabel} could not flip prior run back to running for`,
        taskId,
        sessionId,
      );
      return null;
    }
  } catch (e) {
    console.error(`${logLabel} meta updateRun failed for`, taskId, sessionId, e);
    return null;
  }

  let child;
  try {
    child = resumeClaude(
      spawnCwd,
      sessionId,
      retryMessage,
      { mode: "bypassPermissions" },
      settingsPath,
    );
  } catch (e) {
    console.error(`${logLabel} resume failed for`, taskId, sessionId, e);
    // Roll back the running flip so the UI doesn't lie. Best-effort —
    // a failure here just means the row stays at `running` until the
    // staleRunReaper notices the missing process registry entry.
    try {
      await updateRun(sessionsDir, sessionId, {
        status: "failed",
        endedAt: new Date().toISOString(),
      });
    } catch {
      /* swallow — reaper handles it */
    }
    return null;
  }

  // Re-read the row so the caller sees the post-mutation snapshot.
  // Cheap (cache hit on the per-task TTL).
  const refreshedMeta = readMeta(sessionsDir);
  const retryRun = refreshedMeta?.runs.find((r) => r.sessionId === sessionId);
  if (!retryRun) {
    // Shouldn't happen — we just wrote it. Fall back to a synthesized
    // record so callers don't have to handle null on the success path.
    console.error(
      `${logLabel} resumed run vanished from meta for`,
      taskId,
      sessionId,
    );
    return null;
  }

  wireRunLifecycle(
    sessionsDir,
    sessionId,
    child,
    `${logLabel} ${taskId}/${sessionId}`,
  );
  return { sessionId, run: retryRun };
}
