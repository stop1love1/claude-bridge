/**
 * Shared retry-spawn primitive.
 *
 * Five different gates retry a failed/finished child by re-spawning
 * with a context block prepended to the original prompt:
 *
 *   - `crash`     — childRetry.ts after a `failed` exit
 *   - `verify`    — verifyChain.ts after a `verify` step failed
 *   - `preflight` — preflightCheck.ts after preflight rejected the run
 *   - `claim`     — verifier.ts after the LLM claim-checker rejected
 *   - `style`     — styleCritic.ts after the style critic rejected
 *
 * Each path used to inline ~70 lines of identical spawn boilerplate
 * (resolve cwd → eligibility → strategy prefix → spawn → appendRun →
 * lifecycle wire). Since the only per-gate variation is the rendered
 * context block, the gate name, and the log label, we factor the
 * boilerplate here and let each module supply only the bits that
 * actually differ.
 *
 * The role suffix on the spawned `Run` is derived via
 * `nextRetryRole(baseRole, gate, attempt)` — same wiring the inline
 * copies used, so existing tests (retry-budget enforcement, sibling
 * detection) keep passing without changes.
 */
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { getApp } from "./apps";
import { appendRun, readMeta, type Run } from "./meta";
import { wireRunLifecycle } from "./coordinator";
import { resolveRepoCwd } from "./repos";
import { spawnFreeSession } from "./spawn";
import { freeSessionSettingsPath, writeSessionSettings } from "./permissionSettings";
import { readOriginalPrompt } from "./promptStore";
import { inheritWorktreeFields } from "./worktrees";
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
  /** Run that just finished — its role / parent / worktree inherit. */
  finishedRun: Run;
  /** Which gate triggered the retry. Drives eligibility + role suffix. */
  gate: RetryGate;
  /**
   * Pre-rendered failure-context block. Will be sandwiched between the
   * strategy-prefix line and the original prompt. Caller is responsible
   * for the gate-specific content (verify steps, claim diff, preflight
   * findings, …).
   */
  ctxBlock: string;
  /**
   * Body used when `readOriginalPrompt` returns nothing — a few of the
   * gates word this differently ("Read several relevant files first"
   * vs "make forward progress"). Defaults to a generic message.
   */
  fallbackBody?: string;
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

const DEFAULT_FALLBACK_BODY =
  "(original prompt unavailable — repo state and the failure context above are the only signals you have. Inspect the repo, infer the intent, and try to make forward progress.)";

/**
 * Spawn a sibling-not-child retry of `finishedRun`. Returns the new
 * Run record on success, or `null` when:
 *   - the repo can't be resolved (renamed / deleted)
 *   - meta.json is missing for the task
 *   - the retry budget is exhausted
 *   - `spawnFreeSession` itself throws
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
    fallbackBody,
    logLabel,
    precomputedAttempt,
  } = args;

  const sessionsDir = join(SESSIONS_DIR, taskId);

  const md = readBridgeMd();
  const liveRepoCwd = resolveRepoCwd(md, BRIDGE_ROOT, finishedRun.repo);
  if (!liveRepoCwd) return null;
  // Retries inherit the parent's worktree so they edit the same
  // sandbox the original run started in.
  const spawnCwd = finishedRun.worktreePath ?? liveRepoCwd;

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

  const originalPrompt = readOriginalPrompt(taskId, finishedRun);
  const body = originalPrompt.trim() || fallbackBody || DEFAULT_FALLBACK_BODY;
  const retryPrompt = [strategyPrefix, ctxBlock, "---", "", body].join("\n");

  const sessionId = randomUUID();
  const settingsPath = writeSessionSettings(freeSessionSettingsPath(sessionId));

  let childHandle;
  try {
    childHandle = spawnFreeSession(
      spawnCwd,
      retryPrompt,
      { mode: "bypassPermissions" },
      settingsPath,
      sessionId,
    );
  } catch (e) {
    console.error(`${logLabel} spawn failed for`, taskId, finishedRun.sessionId, e);
    return null;
  }

  const retryRun: Run = {
    sessionId,
    role: nextRetryRole(parsed.baseRole, gate, nextAttempt),
    repo: finishedRun.repo,
    status: "running",
    startedAt: new Date().toISOString(),
    endedAt: null,
    parentSessionId: finishedRun.parentSessionId ?? null,
    retryOf: finishedRun.sessionId,
    retryAttempt: nextAttempt,
    ...inheritWorktreeFields(finishedRun),
  };
  await appendRun(sessionsDir, retryRun);
  wireRunLifecycle(
    sessionsDir,
    sessionId,
    childHandle.child,
    `${logLabel} ${taskId}/${sessionId}`,
  );
  return { sessionId, run: retryRun };
}
