/**
 * Run-lifecycle wiring + post-exit gate orchestration.
 *
 * Extracted out of `coordinator.ts` so the file that runs WHEN a child
 * exits is separate from the file that DEFINES coordinator-spawn /
 * detect-scope plumbing. coordinator.ts re-exports `wireRunLifecycle`
 * from here so existing importers (`retrySpawn`, `semanticVerifier`,
 * `app/api/tasks/[id]/agents`) keep working unchanged — see the
 * re-export at the bottom of `coordinator.ts`.
 *
 * Why this still uses lazy `require` for the five gate modules:
 *
 *   The post-exit pipeline needs to call into `verifyChain`,
 *   `verifier`, `preflightCheck`, `styleCritic`, and
 *   `semanticVerifier`. Each of THOSE modules calls `wireRunLifecycle`
 *   for its own retry-spawn lifecycle (via `retrySpawn`). A static
 *   import in either direction creates a cycle. We could break it via
 *   a registration registry, but the cycle is intrinsic to the design
 *   ("a run's exit triggers gate X; gate X's retry IS another run
 *   whose exit triggers gate X again") and the registry adds
 *   indirection without removing the conceptual coupling. Lazy require
 *   inside the post-exit branch is the pragmatic break.
 */
import type { ChildProcess } from "node:child_process";
import { basename } from "node:path";
import {
  emitRetried,
  readMeta,
  updateRun,
  type Run,
  type RunVerify,
  type RunVerifyStep,
  type RunVerifier,
  type RunStyleCritic,
  type RunSemanticVerifier,
} from "./meta";
import { BRIDGE_ROOT, readBridgeMd } from "./paths";
import { resolveRepoCwd } from "./repos";
import { getApp, type App } from "./apps";
import {
  autoCommitAndPush,
  mergeIntoTargetBranch,
  readCurrentBranch,
} from "./gitOps";
import { mergeAndRemoveWorktree } from "./worktrees";
import { runDevopsAgent } from "./devops";
import { logError, logInfo, logWarn } from "./log";
// Type-only imports — runtime side resolves via lazy `require` inside
// the post-exit flow to break the import cycle (verifyChain.ts,
// verifier.ts, preflightCheck.ts, styleCritic.ts, and
// semanticVerifier.ts all import `wireRunLifecycle` from this file).
import type * as VerifyChain from "./verifyChain";
import type * as Verifier from "./verifier";
import type * as Preflight from "./preflightCheck";
import type * as StyleCritic from "./styleCritic";
import type * as SemanticVerifier from "./semanticVerifier";

function loadVerifyChain(): typeof VerifyChain {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require("./verifyChain") as typeof VerifyChain;
}
function loadVerifier(): typeof Verifier {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require("./verifier") as typeof Verifier;
}
function loadPreflight(): typeof Preflight {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require("./preflightCheck") as typeof Preflight;
}
function loadStyleCritic(): typeof StyleCritic {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require("./styleCritic") as typeof StyleCritic;
}
function loadSemanticVerifier(): typeof SemanticVerifier {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require("./semanticVerifier") as typeof SemanticVerifier;
}

/**
 * Patch one of the four post-exit-gate fields onto the run, atomically
 * combined with the `running → done` status flip when this is the first
 * gate to write meta after `succeedRun` deferred the flip.
 *
 * Why a helper: the four gates (verify chain, preflight/verifier,
 * style critic, semantic verifier) all need the same race-safe
 * pattern — read meta, check whether status is still `running`, write
 * one combined patch (status flip + field) OR a field-only patch. The
 * inline copies were 4× identical 12-line blocks; one transcription
 * error in the next-added 5th gate would silently demote a `done`
 * row back to `running`.
 *
 * Field is `keyof Run` constrained to the gate-result slots so a
 * callsite can't pass `status` or `role` and accidentally bypass the
 * status guard.
 */
type GateField = "verify" | "verifier" | "styleCritic" | "semanticVerifier";
async function attachGateResult<F extends GateField>(
  dir: string,
  runSessionId: string,
  field: F,
  value: Run[F],
): Promise<void> {
  const metaNow = readMeta(dir);
  const r = metaNow?.runs.find((x) => x.sessionId === runSessionId);
  const patch: Partial<Run> = { [field]: value } as Partial<Run>;
  if (r && r.status === "running") {
    patch.status = "done";
    patch.endedAt = new Date().toISOString();
  }
  await updateRun(dir, runSessionId, patch);
}

/**
 * Shared context every post-exit gate operates on. Built once at the
 * top of postExitFlow so each gate doesn't re-resolve the app or
 * re-load the verifyChain module.
 */
interface PostExitContext {
  /** Sessions dir for this task: `SESSIONS_DIR/<taskId>`. */
  dir: string;
  /** Task id (e.g. `t_20260101_001`). */
  tid: string;
  /** Pretty tag for log lines: `<role>:<sessionId-prefix>`. */
  t: string;
  /** Run that just exited. */
  run: Run;
  /** Task title (used by gates that prompt LLMs + by the commit message). */
  title: string;
  /** Resolved app, or null when the run targets an unregistered repo. */
  app: App | null;
}

/**
 * Gate outcome semantics:
 *   - "proceed" — gate passed (or didn't apply); continue down the pipe
 *   - "blocked" — gate failed (or its retry was scheduled); stop the
 *     pipeline so the failed run doesn't reach auto-commit
 */
type GateOutcome = "proceed" | "blocked";

/**
 * Verify-chain gate. Runs the app's configured `test`/`lint`/`build`/
 * `typecheck`/`format` commands inside the run's worktree (or live
 * tree). Failure schedules a `<role>-vretry` and blocks auto-commit;
 * success records the result and proceeds.
 */
async function runVerifyChainGate(ctx: PostExitContext): Promise<GateOutcome> {
  const { dir, tid, t, run, app } = ctx;
  const vc = loadVerifyChain();
  const verifyCfg = vc.verifyConfigOf(app);
  const willRunVerify =
    app !== null &&
    vc.hasAnyVerifyCommand(verifyCfg) &&
    !vc.isAlreadyRetryRun(run.role);

  if (!willRunVerify || !verifyCfg || !app) return "proceed";

  let verifyResult: RunVerify | null = null;
  let verifyCrashed = false;
  {
    try {
      verifyResult = await vc.runVerifyChain({
        // P4: run the verify chain inside the run's worktree when
        // present so it tests the agent's actual edits, not the live
        // tree's pre-spawn state.
        cwd: run.worktreePath ?? app.path,
        verify: verifyCfg,
      });
    } catch (err) {
      logError("verify", "chain crashed", err, { tag: t });
      verifyResult = null;
      verifyCrashed = true;
    }

    // Decide whether to retry BEFORE writing meta. We then collapse the
    // status-flip + verify result + retryScheduled flag into a single
    // updateRun call so concurrent writes (e.g. the new retry run's
    // appendRun fired by spawnVerifyRetry) can't race a follow-up
    // patch on the same record.
    let scheduledRetry: Awaited<ReturnType<typeof vc.spawnVerifyRetry>> = null;
    if (verifyResult && !verifyResult.passed) {
      const metaForCheck = readMeta(dir);
      const eligible =
        !!metaForCheck &&
        vc.isEligibleForVerifyRetry({ finishedRun: run, meta: metaForCheck, retry: app?.retry });
      if (eligible) {
        scheduledRetry = await vc.spawnVerifyRetry({
          taskId: tid,
          finishedRun: run,
          verify: verifyResult,
        });
      }
    }

    const finalVerify: RunVerify | null = verifyResult
      ? { ...verifyResult, retryScheduled: !!scheduledRetry }
      : null;

    if (finalVerify) {
      await attachGateResult(dir, run.sessionId, "verify", finalVerify);
    }

    // If the verify chain itself crashed (not just a step failing —
    // the whole runVerifyChain threw), we have no signal whether the
    // agent's work passed or not. Treating that as "pass" would
    // silently release the commit gate; treat it as an inconclusive
    // failure that blocks the commit. Still flip the run to done so
    // the UI doesn't hang on `running`.
    if (verifyCrashed) {
      logWarn("verify", "chain crashed — blocking auto-commit (operator must verify manually)", { tag: t });
      await updateRun(
        dir,
        run.sessionId,
        { status: "done", endedAt: new Date().toISOString() },
        (r) => r.status === "running",
      );
      return "blocked";
    }

    if (verifyResult && !verifyResult.passed) {
      const failedName = verifyResult.steps.find((s: RunVerifyStep) => !s.ok)?.name;
      if (scheduledRetry) {
        // Fire the SSE retried event so AgentTree draws the retryOf
        // arrow — same contract as crash-retry path emits via
        // childRetry.maybeScheduleRetry → emitRetried.
        emitRetried(tid, scheduledRetry.run, run.sessionId);
        logInfo("verify", `chain failed at \`${failedName}\` — spawned retry`, {
          tag: t,
          retrySessionId: scheduledRetry.sessionId,
        });
      } else {
        logInfo("verify", `chain failed at \`${failedName}\` — retry ineligible / already attempted`, { tag: t });
      }
      // Verify failed → block the auto-commit. The retry (if any) will
      // re-trigger this whole flow when it exits.
      return "blocked";
    }
  }
  return "proceed";
}

/**
 * Preflight gate. Did the agent actually read enough of the codebase
 * before editing? Runs BEFORE the verifier (claim-vs-diff) because if
 * the agent didn't follow process there's no point comparing claims
 * that come from process drift. Reuses the `-cretry` suffix and budget
 * — a single follow-up per (parent, role) covers either preflight OR
 * claim-vs-diff failures, since both signal "agent didn't follow
 * process". The `!isAlreadyRetryRun` guard mirrors the verify-chain
 * branch's gate; without it, future drift in `runPreflight`'s internal
 * retry skip would open an infinite-retry footgun.
 */
async function runPreflightGate(ctx: PostExitContext): Promise<GateOutcome> {
  const { dir, tid, t, run, app } = ctx;
  const vcGuard = loadVerifyChain();
  if (!app || vcGuard.isAlreadyRetryRun(run.role)) return "proceed";

  const pf = loadPreflight();
  // Resolve repoCwd the same way `agents/route.ts` did at spawn time.
  // The child's `.jsonl` lives under `projectDirFor(repoCwd)` —
  // using `app.path` instead can land us in a different slug if
  // BRIDGE.md and `bridge.json` happen to spell the same dir
  // differently (case, symlinks, trailing slash). Fall back to
  // `app.path` when BRIDGE.md is missing — preflight will then skip
  // silently if the slug differs.
  // P4: when the run executed in a worktree, the transcript lives
  // under `projectDirFor(worktreePath)` — preflight needs to read
  // from that exact same cwd or the file lookup misses.
  let preflightCwd = run.worktreePath ?? app.path;
  if (!run.worktreePath) {
    const md = readBridgeMd();
    if (md) {
      const resolved = resolveRepoCwd(md, BRIDGE_ROOT, run.repo);
      if (resolved) preflightCwd = resolved;
    }
  }
  let preflightResult: Preflight.PreflightResult | null = null;
  try {
    preflightResult = pf.runPreflight({
      finishedRun: run,
      appPath: preflightCwd,
    });
  } catch (err) {
    logError("preflight", "crashed", err, { tag: t });
  }

  if (!preflightResult || preflightResult.verdict !== "fail") return "proceed";

  const metaForCheck = readMeta(dir);
  const eligible =
    !!metaForCheck &&
    pf.isEligibleForPreflightRetry({ finishedRun: run, meta: metaForCheck, retry: app?.retry });
  let scheduledPreflightRetry: Awaited<
    ReturnType<typeof pf.spawnPreflightRetry>
  > = null;
  if (eligible) {
    scheduledPreflightRetry = await pf.spawnPreflightRetry({
      taskId: tid,
      finishedRun: run,
      preflight: preflightResult,
    });
  }

  // Combined patch: status:done + verifier (with preflight reason
  // surfaced via the existing field — we don't add a new schema
  // field for preflight, just piggyback on the verifier slot since
  // the post-exit gate semantics are equivalent).
  const finalVerifier: RunVerifier = {
    verdict: "drift",
    reason: `preflight: ${preflightResult.reason}`,
    claimedFiles: [],
    actualFiles: [],
    unmatchedClaims: [],
    unclaimedActual: [],
    durationMs: 0,
    retryScheduled: !!scheduledPreflightRetry,
  };
  await attachGateResult(dir, run.sessionId, "verifier", finalVerifier);

  if (scheduledPreflightRetry) {
    emitRetried(tid, scheduledPreflightRetry.run, run.sessionId);
    logInfo("preflight", `${preflightResult.reason} — spawned retry`, {
      tag: t,
      retrySessionId: scheduledPreflightRetry.sessionId,
    });
  } else {
    logInfo("preflight", `${preflightResult.reason} — retry ineligible / already attempted`, { tag: t });
  }
  return "blocked";
}

/**
 * Claim-vs-diff verifier gate (P2b-1). Always runs for app runs that
 * aren't themselves retries — the verifier itself is cheap (parse
 * markdown + git status + set diff). Verdict `drift` / `broken`
 * schedules a `-cretry` and blocks; `match` proceeds.
 */
async function runClaimGate(ctx: PostExitContext): Promise<GateOutcome> {
  const { dir, tid, t, run, app } = ctx;
  if (!app) return "proceed";

  const vfn = loadVerifier();
  let verifierResult: RunVerifier | null = null;
  try {
    verifierResult = await vfn.runVerifier({
      // P4: claim-vs-diff has to run where the diff exists.
      appPath: run.worktreePath ?? app.path,
      taskId: tid,
      finishedRun: run,
    });
  } catch (err) {
    logError("verifier", "crashed", err, { tag: t });
    verifierResult = null;
  }

  // Decide retry BEFORE writing meta — same combined-patch pattern
  // as the verify-fail branch above so concurrent writes can't
  // race the same record.
  const needsClaimRetry =
    !!verifierResult &&
    (verifierResult.verdict === "drift" || verifierResult.verdict === "broken");
  let scheduledClaimRetry: Awaited<ReturnType<typeof vfn.spawnClaimRetry>> = null;
  if (needsClaimRetry && verifierResult) {
    const metaForCheck = readMeta(dir);
    const eligible =
      !!metaForCheck &&
      vfn.isEligibleForClaimRetry({ finishedRun: run, meta: metaForCheck, retry: app?.retry });
    if (eligible) {
      scheduledClaimRetry = await vfn.spawnClaimRetry({
        taskId: tid,
        finishedRun: run,
        verifier: verifierResult,
      });
    }
  }

  const finalVerifier: RunVerifier | null = verifierResult
    ? { ...verifierResult, retryScheduled: !!scheduledClaimRetry }
    : null;

  if (finalVerifier) {
    await attachGateResult(dir, run.sessionId, "verifier", finalVerifier);
  }

  if (needsClaimRetry && verifierResult) {
    if (scheduledClaimRetry) {
      emitRetried(tid, scheduledClaimRetry.run, run.sessionId);
      logInfo("verifier", `${verifierResult.verdict} — ${verifierResult.reason} — spawned retry`, {
        tag: t,
        retrySessionId: scheduledClaimRetry.sessionId,
      });
    } else {
      logInfo("verifier", `${verifierResult.verdict} — ${verifierResult.reason} — retry ineligible / already attempted`, { tag: t });
    }
    return "blocked";
  }
  return "proceed";
}

/**
 * Style-critic gate (P2b-2). Opt-in per app via
 * `bridge.json.apps[].quality.critic`. Runs only when the prior gates
 * didn't trigger a retry, the run isn't already a retry, and the app
 * exists. Blocking is gated on `alien` only — `match` and `drift`
 * both ship.
 */
async function runStyleCriticGate(ctx: PostExitContext): Promise<GateOutcome> {
  const { dir, tid, t, run, title, app } = ctx;
  const vcGuard = loadVerifyChain();
  if (!app || app.quality?.critic !== true || vcGuard.isAlreadyRetryRun(run.role)) {
    return "proceed";
  }

  const sc = loadStyleCritic();
  let criticResult: RunStyleCritic | null = null;
  try {
    criticResult = await sc.runStyleCritic({
      // P4: gate runs in the same worktree the coder did so it sees
      // the agent's diff via `git diff HEAD`. Falls back to the live
      // tree when worktree mode is off.
      appPath: run.worktreePath ?? app.path,
      taskId: tid,
      finishedRun: run,
      taskTitle: title,
      taskBody: readMeta(dir)?.taskBody ?? "",
    });
  } catch (err) {
    logError("style-critic", "crashed", err, { tag: t });
    criticResult = null;
  }

  const needsStyleRetry =
    !!criticResult && criticResult.verdict === "alien";
  let scheduledStyleRetry: Awaited<
    ReturnType<typeof sc.spawnStyleCriticRetry>
  > = null;
  if (needsStyleRetry && criticResult) {
    const metaForCheck = readMeta(dir);
    const eligible =
      !!metaForCheck &&
      sc.isEligibleForStyleCriticRetry({
        finishedRun: run,
        meta: metaForCheck,
        retry: app?.retry,
      });
    if (eligible) {
      scheduledStyleRetry = await sc.spawnStyleCriticRetry({
        taskId: tid,
        finishedRun: run,
        critic: criticResult,
      });
    }
  }

  const finalCritic: RunStyleCritic | null = criticResult
    ? { ...criticResult, retryScheduled: !!scheduledStyleRetry }
    : null;

  if (finalCritic) {
    await attachGateResult(dir, run.sessionId, "styleCritic", finalCritic);
  }

  if (needsStyleRetry && criticResult) {
    if (scheduledStyleRetry) {
      emitRetried(tid, scheduledStyleRetry.run, run.sessionId);
      logInfo("style-critic", `${criticResult.verdict} — ${criticResult.reason} — spawned retry`, {
        tag: t,
        retrySessionId: scheduledStyleRetry.sessionId,
      });
    } else {
      logInfo("style-critic", `${criticResult.verdict} — ${criticResult.reason} — retry ineligible / already attempted`, { tag: t });
    }
    return "blocked";
  }
  return "proceed";
}

/**
 * Semantic-verifier gate (P2b-2). Opt-in per app via
 * `bridge.json.apps[].quality.verifier`. Runs only when the prior
 * gates didn't trigger a retry. Blocking is gated on `broken` only.
 */
async function runSemanticVerifierGate(
  ctx: PostExitContext,
): Promise<GateOutcome> {
  const { dir, tid, t, run, title, app } = ctx;
  const vcGuard = loadVerifyChain();
  if (!app || app.quality?.verifier !== true || vcGuard.isAlreadyRetryRun(run.role)) {
    return "proceed";
  }

  const sv = loadSemanticVerifier();
  let semanticResult: RunSemanticVerifier | null = null;
  try {
    semanticResult = await sv.runSemanticVerifier({
      appPath: run.worktreePath ?? app.path,
      taskId: tid,
      finishedRun: run,
      taskTitle: title,
      taskBody: readMeta(dir)?.taskBody ?? "",
    });
  } catch (err) {
    logError("semantic-verifier", "crashed", err, { tag: t });
    semanticResult = null;
  }

  const needsSemanticRetry =
    !!semanticResult && semanticResult.verdict === "broken";
  let scheduledSemanticRetry: Awaited<
    ReturnType<typeof sv.spawnSemanticVerifierRetry>
  > = null;
  if (needsSemanticRetry && semanticResult) {
    const metaForCheck = readMeta(dir);
    const eligible =
      !!metaForCheck &&
      sv.isEligibleForSemanticVerifierRetry({
        finishedRun: run,
        meta: metaForCheck,
        retry: app?.retry,
      });
    if (eligible) {
      scheduledSemanticRetry = await sv.spawnSemanticVerifierRetry({
        taskId: tid,
        finishedRun: run,
        verifier: semanticResult,
      });
    }
  }

  const finalSemantic: RunSemanticVerifier | null = semanticResult
    ? { ...semanticResult, retryScheduled: !!scheduledSemanticRetry }
    : null;

  if (finalSemantic) {
    await attachGateResult(dir, run.sessionId, "semanticVerifier", finalSemantic);
  }

  if (needsSemanticRetry && semanticResult) {
    if (scheduledSemanticRetry) {
      emitRetried(tid, scheduledSemanticRetry.run, run.sessionId);
      logInfo("semantic-verifier", `${semanticResult.verdict} — ${semanticResult.reason} — spawned retry`, {
        tag: t,
        retrySessionId: scheduledSemanticRetry.sessionId,
      });
    } else {
      logInfo("semantic-verifier", `${semanticResult.verdict} — ${semanticResult.reason} — retry ineligible / already attempted`, { tag: t });
    }
    return "blocked";
  }
  return "proceed";
}

/**
 * Async post-exit pipeline:
 *   1. Run verify chain (if app has any commands) — store result + flip
 *      run status to "done" in ONE combined updateRun call.
 *   2. If verify failed → spawn `<role>-vretry` and skip auto-commit.
 *   3. If verify passed (or didn't run) → honor `git.autoCommit` /
 *      `git.autoPush` per the app's settings, same as before P2.
 */
async function postExitFlow(args: {
  sessionsDir: string;
  taskId: string;
  tag: string;
  finishedRun: Run;
  taskTitle: string;
}): Promise<void> {
  const { sessionsDir: dir, taskId: tid, tag: t, finishedRun: run, taskTitle: title } = args;

  const app = getApp(run.repo);
  const ctx: PostExitContext = { dir, tid, t, run, title, app };

  if ((await runVerifyChainGate(ctx)) === "blocked") return;

  if ((await runPreflightGate(ctx)) === "blocked") return;

  if ((await runClaimGate(ctx)) === "blocked") return;

  if ((await runStyleCriticGate(ctx)) === "blocked") return;

  if ((await runSemanticVerifierGate(ctx)) === "blocked") return;

  // Used by the memory-distill block below to skip when this run is
  // already a retry attempt — the lesson belongs to the original
  // primary attempt, not the retry that fixed it.
  const vcGuard = loadVerifyChain();

  // Final safety net: if no app exists for this run (e.g. an
  // unregistered repo), the run is still "running" because succeedRun
  // deferred the status flip waiting for a post-exit gate that never
  // came. Flip it now so the UI doesn't show a stuck "running" row.
  // Coordinator and retry runs already had their status flipped in
  // succeedRun.
  if (!app) {
    const metaNow = readMeta(dir);
    const r = metaNow?.runs.find((x) => x.sessionId === run.sessionId);
    if (r && r.status === "running") {
      await updateRun(dir, run.sessionId, {
        status: "done",
        endedAt: new Date().toISOString(),
      });
    }
  }

  // Speculative winner selection. When this run is part of a fan-out
  // group (Run.speculativeGroup set), atomically claim the win or
  // accept that a sibling already won. Losers skip auto-commit + merge
  // — only the winner's diff lands in the live tree.
  if (run.speculativeGroup) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { claimSpeculativeWinner } = require("./speculative") as typeof import("./speculative");
      const claim = await claimSpeculativeWinner({ taskId: tid, run });
      logInfo("speculative", `${claim.outcome} — ${claim.reason}`, {
        tag: t,
        killedSiblings: claim.killed.length,
      });
      if (!claim.proceed) {
        // Lost the race. Skip auto-commit + worktree merge entirely.
        // Worktree was already removed by claim() above.
        return;
      }
    } catch (err) {
      logError("speculative", "claim crashed", err, { tag: t });
      // Fail-soft: if claim throws, fall through and let auto-commit
      // run normally. Worst case both winner and laggard sibling
      // commit; the operator can untangle in git. Better than
      // blocking ALL auto-commit on a transient bug.
    }
  }

  // Auto-memory distillation. Opt-in per app via `memory.distill`. Runs
  // BEFORE auto-commit so the agent sees the still-uncommitted diff via
  // `git diff HEAD`. Skipped on retry runs (the lesson belongs to the
  // original primary attempt, not the retry that fixed it).
  if (
    app &&
    app.memory?.distill === true &&
    !vcGuard.isAlreadyRetryRun(run.role)
  ) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { runMemoryDistill } = require("./memoryDistill") as typeof import("./memoryDistill");
      const distillResult = await runMemoryDistill({
        appPath: run.worktreePath ?? app.path,
        taskId: tid,
        finishedRun: run,
        taskTitle: title,
        taskBody: readMeta(dir)?.taskBody ?? "",
      });
      if (distillResult.appended > 0) {
        logInfo("memory-distill", distillResult.reason, {
          tag: t,
          distillSessionId: distillResult.distillSessionId,
        });
      } else {
        logInfo("memory-distill", distillResult.reason, { tag: t });
      }
    } catch (err) {
      logError("memory-distill", "crashed", err, { tag: t });
    }
  }

  // Verify passed (or didn't run), verifier passed/skipped → honor
  // the app's auto-commit / auto-push settings, same gate as pre-P2.
  // P4/F1 — when the run executed in a private worktree, run
  // auto-commit there with autoPush DISABLED (we don't want to push
  // the throwaway worktree branch). After merge, the live tree's
  // base branch gets the dedicated push pass below so the operator's
  // expectation that `autoPush=true` puts reviewed commits on the
  // remote actually holds.
  //
  // SAFETY: in worktree mode we ALWAYS auto-commit, even when the
  // operator left `autoCommit=false`. The worktree's whole purpose is
  // to merge back into the base branch on cleanup, and a merge only
  // carries committed changes — uncommitted edits would be silently
  // erased by `git worktree remove --force`. Honoring the
  // operator's `autoCommit=false` here would mean shipping a
  // configuration whose only outcome is data loss, so we override
  // the flag (autoPush stays bound to the operator's setting via
  // the post-merge live-tree push below).
  const useWorktree = !!run.worktreePath;
  const commitCwd = run.worktreePath ?? app?.path ?? null;
  const commitSettings = app
    ? useWorktree
      ? { ...app.git, autoCommit: true, autoPush: false }
      : app.git
    : null;
  const message = `[${tid}] ${title}`.trim();
  if (
    app &&
    commitCwd &&
    commitSettings &&
    (commitSettings.autoCommit || commitSettings.autoPush)
  ) {
    try {
      const r = await autoCommitAndPush(commitCwd, commitSettings, message);
      if (r.ok) {
        logInfo("auto-git", r.message, { tag: t });
      } else {
        logWarn("auto-git", `${r.message} — ${r.error ?? ""}`, { tag: t });
      }
    } catch (err) {
      logError("auto-git", "crashed", err, { tag: t });
    }
  }

  // Non-worktree integration: after auto-commit lands on the work
  // branch (current / fixed / claude/<task-id>), branch on the
  // operator's `integrationMode`. Worktree mode handles its own
  // integration further down — we only run this branch when the run
  // executed in the live tree.
  if (
    app &&
    !run.worktreePath &&
    app.git.integrationMode !== "none" &&
    app.git.mergeTargetBranch.trim().length > 0 &&
    commitCwd
  ) {
    try {
      const sourceBranch = await readCurrentBranch(commitCwd);
      if (!sourceBranch) {
        logWarn("integration", "skipped: detached HEAD or non-git tree", { tag: t, cwd: commitCwd });
      } else if (app.git.integrationMode === "auto-merge") {
        const m = await mergeIntoTargetBranch({
          cwd: commitCwd,
          sourceBranch,
          targetBranch: app.git.mergeTargetBranch,
          message: `merge ${sourceBranch} → ${app.git.mergeTargetBranch} (${tid})`,
          push: app.git.autoPush,
        });
        if (m.ok) {
          logInfo("auto-merge", m.message, { tag: t });
        } else {
          logWarn("auto-merge", `${m.message} — ${m.error ?? ""}`, { tag: t });
        }
      } else if (app.git.integrationMode === "pull-request") {
        const d = await runDevopsAgent({
          appPath: commitCwd,
          taskId: tid,
          finishedRun: run,
          taskTitle: title,
          taskBody: readMeta(dir)?.taskBody ?? "",
          sourceBranch,
          targetBranch: app.git.mergeTargetBranch,
        });
        if (d.status === "opened" || d.status === "exists") {
          logInfo("pull-request", `${d.status} — ${d.reason}`, { tag: t, url: d.url ?? null });
        } else {
          logWarn("pull-request", `${d.status} — ${d.reason}`, { tag: t });
        }
      }
    } catch (err) {
      logError("integration", "crashed", err, { tag: t });
    }
  }

  // P4/F1 — merge the worktree branch back into the base branch and
  // remove the worktree. Runs ONLY on the success path: any failing
  // gate above already returned early so we never reach here. The
  // merge respects whatever auto-commit just did inside the worktree;
  // worktree pruner mops up anything left behind on a crash.
  if (app && run.worktreePath) {
    try {
      const wm = await mergeAndRemoveWorktree({
        appPath: app.path,
        handle: {
          path: run.worktreePath,
          branch: run.worktreeBranch ?? "",
          baseBranch: run.worktreeBaseBranch ?? null,
        },
      });
      if (!wm.ok) {
        logWarn("worktree", `cleanup: ${wm.message} — ${wm.error ?? ""}`, { tag: t });
      } else {
        logInfo("worktree", `cleanup: ${wm.message}`, { tag: t });
      }
      // Worktree integration: after the worktree branch merged into
      // `baseBranch`, branch on integrationMode. Auto-merge runs the
      // local fast-forward into mergeTargetBranch BEFORE the autoPush
      // pass below so that pass pushes the merged target rather than
      // baseBranch. Pull-request mode hands off to the devops agent
      // which opens the PR/MR against the configured target.
      // Conflict on auto-merge is fail-soft: HEAD ends up back on
      // baseBranch and autoPush still pushes that.
      const baseBranch = run.worktreeBaseBranch ?? null;
      if (
        wm.ok &&
        baseBranch &&
        app.git.integrationMode !== "none" &&
        app.git.mergeTargetBranch.trim().length > 0
      ) {
        if (app.git.integrationMode === "auto-merge") {
          const m = await mergeIntoTargetBranch({
            cwd: app.path,
            sourceBranch: baseBranch,
            targetBranch: app.git.mergeTargetBranch,
            message: `merge ${baseBranch} → ${app.git.mergeTargetBranch} (${tid})`,
            // Push handled by the explicit autoPush pass below to
            // keep a single push site per run.
            push: false,
          });
          if (m.ok) {
            logInfo("auto-merge", m.message, { tag: t });
          } else {
            logWarn("auto-merge", `${m.message} — ${m.error ?? ""}`, { tag: t });
          }
        } else if (app.git.integrationMode === "pull-request") {
          const d = await runDevopsAgent({
            appPath: app.path,
            taskId: tid,
            finishedRun: run,
            taskTitle: title,
            taskBody: readMeta(dir)?.taskBody ?? "",
            sourceBranch: baseBranch,
            targetBranch: app.git.mergeTargetBranch,
          });
          if (d.status === "opened" || d.status === "exists") {
            logInfo("pull-request", `${d.status} — ${d.reason}`, { tag: t, url: d.url ?? null });
          } else {
            logWarn("pull-request", `${d.status} — ${d.reason}`, { tag: t });
          }
        }
      }
      // P4/F1 — push the live tree's current branch after a successful
      // merge so `autoPush=true` reaches the merged result, not the
      // throwaway worktree branch we suppressed above. Calling
      // `autoCommitAndPush` with autoCommit=false short-circuits at
      // the "no staged changes" branch, which forwards to `tryPush`
      // when autoPush is on — exactly what we need.
      if (wm.ok && app.git.autoPush) {
        const r = await autoCommitAndPush(
          app.path,
          { ...app.git, autoCommit: false, autoPush: true },
          message,
        );
        if (r.ok) {
          logInfo("auto-push", `live tree: ${r.message}`, { tag: t });
        } else {
          logWarn("auto-push", `live tree: ${r.message} — ${r.error ?? ""}`, { tag: t });
        }
      }
    } catch (err) {
      logError("worktree", "cleanup crashed", err, { tag: t });
    }
  }
}

/**
 * Wire `error` / `exit` lifecycle on a Claude child so its corresponding
 * meta.json run flips to `done` (clean exit) or `failed` (spawn error /
 * non-zero exit). Used by both the coordinator spawn path and the
 * `/api/tasks/<id>/agents` child spawn path so the same belt-and-
 * suspenders behavior applies everywhere — if the child forgot to PATCH
 * itself via the link API, we still close the run out cleanly.
 *
 * Never overwrites a final state the child already set: only flips when
 * the run is still `running` at the moment of exit.
 *
 * Phase D: after marking the run failed, fire the auto-retry path.
 * `maybeScheduleRetry` decides whether the failure is retryable
 * (it's a child, not coordinator-level; no prior retry exists). The
 * retry helper is lazy-imported to break the import cycle (childRetry
 * uses `wireRunLifecycle` for the retry's own lifecycle).
 */
export function wireRunLifecycle(
  sessionsDir: string,
  sessionId: string,
  child: ChildProcess,
  context?: string,
): void {
  const tag = context ?? sessionsDir;
  const taskId = basename(sessionsDir);

  const tryAutoRetry = (exitCode: number | null) => {
    try {
      const meta = readMeta(sessionsDir);
      const failedRun = meta?.runs.find((r) => r.sessionId === sessionId);
      if (!failedRun || failedRun.status !== "failed") return;
      // Speculative loser: the bridge SIGTERM'd this child as part of
      // winner-selection, not because the agent crashed. Retrying
      // would just waste tokens running a path the user already
      // committed (via the winner). Skip auto-retry for losers.
      if (failedRun.speculativeOutcome === "lost") return;
      // Lazy import: childRetry → coordinator (this file) → … breaks
      // the cycle if loaded eagerly at module top.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { maybeScheduleRetry } = require("./childRetry") as typeof import("./childRetry");
      maybeScheduleRetry({ taskId, failedRun, exitCode });
    } catch (e) {
      logError("auto-retry", "hook crashed", e, { tag });
    }
  };

  const failRun = async (reason: string, exitCode: number | null) => {
    try {
      // Precondition guard: only flip running → failed. Without this,
      // a late `exit` after a post-exit gate already wrote `done`
      // could demote the row. The check runs INSIDE the per-task
      // lock so a racing writer can't slip a final state in between
      // the read and the patch.
      await updateRun(
        sessionsDir,
        sessionId,
        { status: "failed", endedAt: new Date().toISOString() },
        (run) => run.status === "running",
      );
    } catch (e) {
      logError("lifecycle", "failed to mark run failed", e, { tag });
    }
    logError("lifecycle", `run failed: ${reason}`, undefined, { tag });
    tryAutoRetry(exitCode);
  };

  const succeedRun = async () => {
    let finishedRun: Run | null = null;
    let taskTitle = "";
    try {
      const meta = readMeta(sessionsDir);
      const run = meta?.runs.find((r) => r.sessionId === sessionId);
      if (run && run.status === "running") {
        // NOTE: defer the status flip when a post-exit gate (verify
        // chain OR claim-vs-diff verifier) will run for this app, so
        // those branches can write status:done + their result in ONE
        // combined updateRun patch — avoids a read-modify-write race
        // and keeps the UI from flashing "done" while a -vretry /
        // -cretry is still being decided. The verifier runs whenever
        // we have an app entry and the role isn't already a retry, so
        // that's the broader gate (a strict superset of "verify chain
        // will run").
        const app = getApp(run.repo);
        const vc = loadVerifyChain();
        const willRunPostExitGate =
          app !== null &&
          run.role !== "coordinator" &&
          !vc.isAlreadyRetryRun(run.role);

        // 2b — coordinator orchestration deferral. When the coordinator's
        // process exits cleanly but it has spawned children that are still
        // queued/running, we DON'T flip status:done immediately. Without
        // this, the badge flashes DONE while a child is visibly mid-task,
        // confusing operators ("task is finished, but fixer-cashier is
        // still running?"). The auto-nudge subscriber
        // (`libs/coordinatorNudge.ts`) finalizes the flip when children
        // settle — same trigger that resumes the coordinator on the next
        // turn. Failure path (`failRun`) is intentionally NOT deferred:
        // a crashed/killed coordinator is a real terminal state regardless
        // of whether children are alive.
        const isCoordWithActiveChildren =
          run.role === "coordinator" &&
          !!meta &&
          meta.runs.some(
            (r) =>
              r.parentSessionId === sessionId &&
              r.sessionId !== sessionId &&
              (r.status === "queued" || r.status === "running"),
          );

        if (!willRunPostExitGate && !isCoordWithActiveChildren) {
          await updateRun(
            sessionsDir,
            sessionId,
            { status: "done", endedAt: new Date().toISOString() },
            (r) => r.status === "running",
          );
        }
      }
      if (run && meta) {
        finishedRun = run;
        taskTitle = meta.taskTitle;
      }
    } catch (e) {
      logError("lifecycle", "failed to mark run done", e, { tag });
    }

    // P2 — verify chain + commit gate. Wrapped in an async IIFE so the
    // `child.on("exit", ...)` handler stays sync; rejections surface via
    // .catch() rather than crashing the Next.js dev server (Risk 1).
    //
    // Safety net: if postExitFlow throws BEFORE any gate had a chance to
    // call attachGateResult (which writes status:done), the run would
    // stay status:running until the stale-run reaper notices the
    // registry-miss on the next read.
    // The catch below explicitly flips status:done (precondition: still
    // running) so a crash in loadVerifyChain / verifyConfigOf cannot
    // ghost a successful child indefinitely.
    if (finishedRun && finishedRun.role !== "coordinator") {
      void postExitFlow({
        sessionsDir,
        taskId,
        tag,
        finishedRun,
        taskTitle,
      }).catch(async (err) => {
        logError("post-exit", "flow crashed", err, { tag });
        try {
          await updateRun(
            sessionsDir,
            sessionId,
            { status: "done", endedAt: new Date().toISOString() },
            (r) => r.status === "running",
          );
        } catch (e) {
          logError("post-exit", "safety-net status:done flip failed", e, { tag });
        }
      });
    }
  };

  child.once("error", (err) => {
    void failRun(`spawn error: ${err.message}`, null);
    // Reap per-session settings dir on abnormal exit too — the
    // child never landed, so the settings file we wrote alongside
    // it is now garbage. Defer to the next tick so the failRun
    // updateRun gets a chance to land first (cosmetic ordering).
    setImmediate(() => {
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { cleanupSessionSettings } = require("./permissionSettings") as typeof import("./permissionSettings");
        cleanupSessionSettings(sessionId);
      } catch { /* swallow */ }
    });
  });
  // `once`, not `on`: an exit event must drive `succeedRun`/`failRun` —
  // and therefore the gate chain in `postExitFlow` — exactly one time.
  // If `wireRunLifecycle` were ever called twice for the same child,
  // `on` would queue a duplicate retry spawn after the precondition
  // guard inside `updateRun` short-circuited the second status flip.
  child.once("exit", (code, signal) => {
    if (code === 0) {
      void succeedRun();
    } else if (code !== null) {
      void failRun(`exit code ${code}`, code);
    } else {
      // code === null means the child was terminated by a signal
      // (e.g. SIGTERM from the stop button or speculative-loser
      // selection). Without an explicit branch the run would stay
      // status:running until the stale-run reaper notices the
      // registry-miss on the next read.
      // Treat it as a failed run so failRun's tryAutoRetry logic
      // (which knows about speculativeOutcome === "lost") can decide
      // whether to retry or just terminate cleanly.
      void failRun(`killed by signal ${signal ?? "unknown"}`, null);
    }
    // Always reap the per-session settings file on terminal exit —
    // success path included. The dir is owned exclusively by this
    // session so once the process is gone nothing else needs it.
    setImmediate(() => {
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { cleanupSessionSettings } = require("./permissionSettings") as typeof import("./permissionSettings");
        cleanupSessionSettings(sessionId);
      } catch { /* swallow */ }
    });
  });
}
