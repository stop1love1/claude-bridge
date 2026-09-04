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
import { getApp, semanticVerifierEnabled, type App } from "./apps";
import { computeConfidence, shouldHoldOutward } from "./confidenceScore";
import { readConfidenceConfig } from "./confidenceConfig";
import {
  autoCommitAndPush,
  mergeIntoTargetBranch,
  readCurrentBranch,
} from "./gitOps";
import { mergeAndRemoveWorktree } from "./worktrees";
import { runDevopsAgent } from "./devops";
import { escalateGateBlock, type EscalationGate } from "./gateEscalation";
import { releaseRepoReservation } from "./repoReservation";
import { logError, logInfo, logWarn } from "./log";
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

async function blockOnGateCrash<F extends GateField>(
  ctx: PostExitContext,
  opts: {
    logScope: string;
    field: F;
    gateResult: Run[F];
    gate: EscalationGate;
    reason: string;
  },
): Promise<"blocked"> {
  const { dir, tid, t, run } = ctx;
  logWarn(opts.logScope, "crashed — blocking auto-commit (operator must verify manually)", { tag: t });
  await attachGateResult(dir, run.sessionId, opts.field, opts.gateResult);
  await escalateGateBlock({
    taskId: tid,
    sessionsDir: dir,
    gate: opts.gate,
    reason: opts.reason,
    retryScheduled: false,
  });
  return "blocked";
}

export async function markMergeNotPushed(
  dir: string,
  runSessionId: string,
  message: string,
  error?: string,
): Promise<void> {
  try {
    await updateRun(dir, runSessionId, {
      mergeNotPushed: {
        message,
        error: error ?? null,
        at: new Date().toISOString(),
      },
    });
  } catch (e) {
    logError("lifecycle", "markMergeNotPushed failed", e);
  }
}

interface PostExitContext {
  dir: string;
  tid: string;
  t: string;
  run: Run;
  title: string;
  app: App | null;
  identityRetained: boolean;
  observedChangedFiles: string[] | null;
}

type GateOutcome = "proceed" | "blocked";

function observedNoChanges(ctx: PostExitContext): boolean {
  return ctx.observedChangedFiles !== null && ctx.observedChangedFiles.length === 0;
}

async function runVerifyChainGate(ctx: PostExitContext): Promise<GateOutcome> {
  const { dir, tid, t, run, app } = ctx;
  const vc = loadVerifyChain();
  const verifyCfg = vc.verifyConfigOf(app);
  const willRunVerify =
    app !== null && vc.hasAnyVerifyCommand(verifyCfg);

  if (!willRunVerify || !verifyCfg || !app) return "proceed";

  let verifyResult: RunVerify | null = null;
  let verifyCrashed = false;
  {
    try {
      verifyResult = await vc.runVerifyChain({
        cwd: run.worktreePath ?? app.path,
        verify: verifyCfg,
      });
    } catch (err) {
      logError("verify", "chain crashed", err, { tag: t });
      verifyResult = null;
      verifyCrashed = true;
    }

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

    if (verifyCrashed) {
      logWarn("verify", "chain crashed — blocking auto-commit (operator must verify manually)", { tag: t });
      await updateRun(
        dir,
        run.sessionId,
        { status: "done", endedAt: new Date().toISOString() },
        (r) => r.status === "running",
      );
      await escalateGateBlock({
        taskId: tid,
        sessionsDir: dir,
        gate: "verify",
        reason: "verify chain crashed — inconclusive",
        retryScheduled: false,
      });
      return "blocked";
    }

    if (verifyResult && !verifyResult.passed) {
      const failedName = verifyResult.steps.find((s: RunVerifyStep) => !s.ok)?.name;
      if (scheduledRetry) {
        ctx.identityRetained = true;
        emitRetried(tid, scheduledRetry.run, run.sessionId);
        logInfo("verify", `chain failed at \`${failedName}\` — spawned retry`, {
          tag: t,
          retrySessionId: scheduledRetry.sessionId,
        });
      } else {
        logInfo("verify", `chain failed at \`${failedName}\` — retry ineligible / already attempted`, { tag: t });
        await escalateGateBlock({
          taskId: tid,
          sessionsDir: dir,
          gate: "verify",
          reason: `chain failed at \`${failedName}\` — retry ineligible / already attempted`,
          retryScheduled: false,
        });
      }
      return "blocked";
    }
  }
  return "proceed";
}

async function runPreflightGate(ctx: PostExitContext): Promise<GateOutcome> {
  const { dir, tid, t, run, app } = ctx;
  if (!app) return "proceed";

  const pf = loadPreflight();
  let preflightCwd = run.worktreePath ?? app.path;
  if (!run.worktreePath) {
    const md = readBridgeMd();
    if (md) {
      const resolved = resolveRepoCwd(md, BRIDGE_ROOT, run.repo);
      if (resolved) preflightCwd = resolved;
    }
  }
  let preflightResult: Preflight.PreflightResult | null = null;
  let preflightCrashed = false;
  try {
    preflightResult = pf.runPreflight({
      finishedRun: run,
      appPath: preflightCwd,
    });
  } catch (err) {
    logError("preflight", "crashed", err, { tag: t });
    preflightResult = null;
    preflightCrashed = true;
  }

  if (preflightCrashed) {
    return await blockOnGateCrash(ctx, {
      logScope: "preflight",
      field: "verifier",
      gateResult: {
        verdict: "crashed",
        reason: "preflight crashed — inconclusive",
        claimedFiles: [],
        actualFiles: [],
        unmatchedClaims: [],
        unclaimedActual: [],
        durationMs: 0,
        retryScheduled: false,
      },
      gate: "preflight",
      reason: "preflight crashed — inconclusive",
    });
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
    ctx.identityRetained = true;
    emitRetried(tid, scheduledPreflightRetry.run, run.sessionId);
    logInfo("preflight", `${preflightResult.reason} — spawned retry`, {
      tag: t,
      retrySessionId: scheduledPreflightRetry.sessionId,
    });
  } else {
    logInfo("preflight", `${preflightResult.reason} — retry ineligible / already attempted`, { tag: t });
    await escalateGateBlock({
      taskId: tid,
      sessionsDir: dir,
      gate: "preflight",
      reason: `${preflightResult.reason} — retry ineligible / already attempted`,
      retryScheduled: false,
    });
  }
  return "blocked";
}

async function runClaimGate(ctx: PostExitContext): Promise<GateOutcome> {
  const { dir, tid, t, run, app } = ctx;
  if (!app) return "proceed";

  const vfn = loadVerifier();
  let verifierResult: RunVerifier | null = null;
  let claimCrashed = false;
  try {
    verifierResult = await vfn.runVerifier({
      appPath: run.worktreePath ?? app.path,
      taskId: tid,
      finishedRun: run,
    });
  } catch (err) {
    logError("verifier", "crashed", err, { tag: t });
    verifierResult = null;
    claimCrashed = true;
  }

  if (claimCrashed) {
    return await blockOnGateCrash(ctx, {
      logScope: "verifier",
      field: "verifier",
      gateResult: {
        verdict: "crashed",
        reason: "claim verifier crashed — inconclusive",
        claimedFiles: [],
        actualFiles: [],
        unmatchedClaims: [],
        unclaimedActual: [],
        durationMs: 0,
        retryScheduled: false,
      },
      gate: "claim",
      reason: "claim verifier crashed — inconclusive",
    });
  }

  if (verifierResult && verifierResult.verdict !== "skipped") {
    ctx.observedChangedFiles = verifierResult.actualFiles;
  }

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
      ctx.identityRetained = true;
      emitRetried(tid, scheduledClaimRetry.run, run.sessionId);
      logInfo("verifier", `${verifierResult.verdict} — ${verifierResult.reason} — spawned retry`, {
        tag: t,
        retrySessionId: scheduledClaimRetry.sessionId,
      });
    } else {
      logInfo("verifier", `${verifierResult.verdict} — ${verifierResult.reason} — retry ineligible / already attempted`, { tag: t });
      await escalateGateBlock({
        taskId: tid,
        sessionsDir: dir,
        gate: "claim",
        reason: `${verifierResult.verdict} — ${verifierResult.reason} — retry ineligible / already attempted`,
        retryScheduled: false,
      });
    }
    return "blocked";
  }
  return "proceed";
}

async function runStyleCriticGate(ctx: PostExitContext): Promise<GateOutcome> {
  const { dir, tid, t, run, title, app } = ctx;
  if (!app || app.quality?.critic !== true) {
    return "proceed";
  }
  if (observedNoChanges(ctx)) {
    logInfo("style-critic", "skipped — run produced no changed files, no diff to judge", { tag: t });
    return "proceed";
  }

  const sc = loadStyleCritic();
  let criticResult: RunStyleCritic | null = null;
  let styleCrashed = false;
  try {
    criticResult = await sc.runStyleCritic({
      appPath: run.worktreePath ?? app.path,
      taskId: tid,
      finishedRun: run,
      taskTitle: title,
      taskBody: readMeta(dir)?.taskBody ?? "",
    });
  } catch (err) {
    logError("style-critic", "crashed", err, { tag: t });
    criticResult = null;
    styleCrashed = true;
  }

  if (styleCrashed) {
    return await blockOnGateCrash(ctx, {
      logScope: "style-critic",
      field: "styleCritic",
      gateResult: {
        verdict: "crashed",
        reason: "style critic crashed — inconclusive",
        issues: [],
        durationMs: 0,
        retryScheduled: false,
      },
      gate: "style",
      reason: "style critic crashed — inconclusive",
    });
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
      ctx.identityRetained = true;
      emitRetried(tid, scheduledStyleRetry.run, run.sessionId);
      logInfo("style-critic", `${criticResult.verdict} — ${criticResult.reason} — spawned retry`, {
        tag: t,
        retrySessionId: scheduledStyleRetry.sessionId,
      });
    } else {
      logInfo("style-critic", `${criticResult.verdict} — ${criticResult.reason} — retry ineligible / already attempted`, { tag: t });
      await escalateGateBlock({
        taskId: tid,
        sessionsDir: dir,
        gate: "style",
        reason: `${criticResult.verdict} — ${criticResult.reason} — retry ineligible / already attempted`,
        retryScheduled: false,
      });
    }
    return "blocked";
  }
  return "proceed";
}

async function runSemanticVerifierGate(
  ctx: PostExitContext,
): Promise<GateOutcome> {
  const { dir, tid, t, run, title, app } = ctx;
  if (!app || !semanticVerifierEnabled(app)) {
    return "proceed";
  }
  if (observedNoChanges(ctx)) {
    logInfo("semantic-verifier", "skipped — run produced no changed files, no diff to judge", { tag: t });
    return "proceed";
  }

  const sv = loadSemanticVerifier();
  let semanticResult: RunSemanticVerifier | null = null;
  let semanticCrashed = false;
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
    semanticCrashed = true;
  }

  if (semanticCrashed) {
    return await blockOnGateCrash(ctx, {
      logScope: "semantic-verifier",
      field: "semanticVerifier",
      gateResult: {
        verdict: "crashed",
        reason: "semantic verifier crashed — inconclusive",
        concerns: [],
        durationMs: 0,
        retryScheduled: false,
      },
      gate: "semantic",
      reason: "semantic verifier crashed — inconclusive",
    });
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
      ctx.identityRetained = true;
      emitRetried(tid, scheduledSemanticRetry.run, run.sessionId);
      logInfo("semantic-verifier", `${semanticResult.verdict} — ${semanticResult.reason} — spawned retry`, {
        tag: t,
        retrySessionId: scheduledSemanticRetry.sessionId,
      });
    } else {
      logInfo("semantic-verifier", `${semanticResult.verdict} — ${semanticResult.reason} — retry ineligible / already attempted`, { tag: t });
      await escalateGateBlock({
        taskId: tid,
        sessionsDir: dir,
        gate: "semantic",
        reason: `${semanticResult.verdict} — ${semanticResult.reason} — retry ineligible / already attempted`,
        retryScheduled: false,
      });
    }
    return "blocked";
  }
  return "proceed";
}

interface PostExitFlowResult {
  releaseReservation: boolean;
}

// Run in order; the first gate that blocks stops the run short of any
// commit / merge / integration. Adding a gate means adding it here.
const GATE_SEQUENCE: Array<(ctx: PostExitContext) => Promise<GateOutcome>> = [
  runVerifyChainGate,
  runPreflightGate,
  runClaimGate,
  runStyleCriticGate,
  runSemanticVerifierGate,
];

async function postExitFlow(args: {
  sessionsDir: string;
  taskId: string;
  tag: string;
  finishedRun: Run;
  taskTitle: string;
}): Promise<PostExitFlowResult> {
  const { sessionsDir: dir, taskId: tid, tag: t, finishedRun: run, taskTitle: title } = args;

  const app = getApp(run.repo);
  const ctx: PostExitContext = {
    dir,
    tid,
    t,
    run,
    title,
    app,
    identityRetained: false,
    observedChangedFiles: null,
  };

  for (const gate of GATE_SEQUENCE) {
    if ((await gate(ctx)) === "blocked") {
      return { releaseReservation: !ctx.identityRetained };
    }
  }

  const vcGuard = loadVerifyChain();

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
        return { releaseReservation: true };
      }
    } catch (err) {
      logError("speculative", "claim crashed", err, { tag: t });
    }
  }

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

  const useWorktree = !!run.worktreePath;

  let held = false;
  if (app) {
    try {
      const judged = readMeta(dir)?.runs.find((r) => r.sessionId === run.sessionId) ?? run;
      const conf = computeConfidence(judged);
      const cfg = readConfidenceConfig();
      held = shouldHoldOutward(conf.score, cfg, useWorktree);
      await updateRun(dir, run.sessionId, {
        confidence: {
          score: conf.score,
          band: conf.band,
          heldAt: held ? new Date().toISOString() : null,
          reviewedBy: null,
        },
      });
      if (held) {
        logWarn("confidence", `score ${conf.score} (${conf.band}) < threshold ${cfg.threshold} — holding push/integration for review`, { tag: t });
      } else {
        logInfo("confidence", `score ${conf.score} (${conf.band})`, { tag: t });
      }
    } catch (err) {
      logError("confidence", "scoring crashed (non-fatal)", err, { tag: t });
    }
  }

  const commitCwd = run.worktreePath ?? app?.path ?? null;
  const commitSettings = app
    ? useWorktree
      ? { ...app.git, autoCommit: true, autoPush: false }
      : held
        ? { ...app.git, autoPush: false }
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

  if (
    app &&
    !held &&
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
          pushTimeoutMs: app.git.pushTimeoutMs,
        });
        if (m.ok) {
          logInfo("auto-merge", m.message, { tag: t });
        } else {
          logWarn("auto-merge", `${m.message} — ${m.error ?? ""}`, { tag: t });
          if (m.message.startsWith("MERGE-NO-PUSH:")) {
            await markMergeNotPushed(dir, run.sessionId, m.message, m.error);
          }
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

  if (app && run.worktreePath) {
    if (held) {
      logInfo("confidence", "worktree run held — merge-back deferred pending operator review", { tag: t });
    } else {
      const mb = await performWorktreeMergeBack({ app, run, tid, title, t, dir, message });
      if (!mb.ok && mb.stage === "merge") {
        logWarn("worktree", `automatic merge-back conflicted — worktree kept, escalating: ${mb.detail ?? ""}`, { tag: t });
        await markMergeNotPushed(
          dir,
          run.sessionId,
          `MERGE-CONFLICT: automatic worktree merge-back failed to land — worktree kept, resolve and retry: ${mb.detail ?? "see server logs"}`,
          mb.detail,
        );
        await escalateGateBlock({
          taskId: tid,
          sessionsDir: dir,
          gate: "merge",
          reason: mb.detail ?? "automatic worktree merge-back conflicted",
          retryScheduled: false,
        });
      }
    }
  }

  return { releaseReservation: true };
}

export interface WorktreeMergeBackResult {
  ok: boolean;
  stage?: "merge" | "integration" | "push";
  detail?: string;
}

export async function performWorktreeMergeBack(params: {
  app: App;
  run: Run;
  tid: string;
  title: string;
  t: string;
  dir: string;
  message: string;
}): Promise<WorktreeMergeBackResult> {
  const { app, run, tid, title, t, dir, message } = params;
  if (!run.worktreePath) return { ok: true };
  let firstFailure: WorktreeMergeBackResult | null = null;
  let stage: "merge" | "integration" | "push" = "merge";
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
      return { ok: false, stage: "merge", detail: `${wm.message}${wm.error ? ` — ${wm.error}` : ""}` };
    }
    logInfo("worktree", `cleanup: ${wm.message}`, { tag: t });
    stage = "integration";
    const baseBranch = run.worktreeBaseBranch ?? null;
    if (
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
          push: false,
        });
        if (m.ok) {
          logInfo("auto-merge", m.message, { tag: t });
        } else {
          logWarn("auto-merge", `${m.message} — ${m.error ?? ""}`, { tag: t });
          firstFailure ??= { ok: false, stage: "integration", detail: `${m.message}${m.error ? ` — ${m.error}` : ""}` };
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
          firstFailure ??= { ok: false, stage: "integration", detail: `${d.status} — ${d.reason}` };
        }
      }
    }
    stage = "push";
    if (app.git.autoPush) {
      const r = await autoCommitAndPush(
        app.path,
        { ...app.git, autoCommit: false, autoPush: true },
        message,
      );
      if (r.ok) {
        logInfo("auto-push", `live tree: ${r.message}`, { tag: t });
      } else {
        logWarn("auto-push", `live tree: ${r.message} — ${r.error ?? ""}`, { tag: t });
        await markMergeNotPushed(
          dir,
          run.sessionId,
          `MERGE-NO-PUSH: worktree merge landed locally but push failed: ${r.message}`,
          r.error,
        );
        firstFailure ??= { ok: false, stage: "push", detail: `${r.message}${r.error ? ` — ${r.error}` : ""}` };
      }
    }
  } catch (err) {
    logError("worktree", "cleanup crashed", err, { tag: t });
    firstFailure ??= {
      ok: false,
      stage,
      detail: `crashed during ${stage}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  return firstFailure ?? { ok: true };
}

export function wireRunLifecycle(
  sessionsDir: string,
  sessionId: string,
  child: ChildProcess,
  repo: string,
  context?: string,
): void {
  const tag = context ?? sessionsDir;
  const taskId = basename(sessionsDir);

  const loadFailedRunForRetry = (): Run | null => {
    const meta = readMeta(sessionsDir);
    const failedRun = meta?.runs.find((r) => r.sessionId === sessionId);
    if (!failedRun || failedRun.status !== "failed") return null;
    if (failedRun.speculativeOutcome === "lost") return null;
    return failedRun;
  };

  const tryAutoRetry = (failedRun: Run, exitCode: number | null) => {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { maybeScheduleRetry } = require("./childRetry") as typeof import("./childRetry");
      maybeScheduleRetry({ taskId, failedRun, exitCode });
    } catch (e) {
      logError("auto-retry", "hook crashed", e, { tag });
    }
  };

  const failRun = async (reason: string, exitCode: number | null) => {
    try {
      await updateRun(
        sessionsDir,
        sessionId,
        { status: "failed", endedAt: new Date().toISOString() },
        (run) => run.status === "running",
      );
    } catch (e) {
      logError("lifecycle", "failed to mark run failed", e, { tag });
    }

    const failedRun = loadFailedRunForRetry();
    let retryWillBeAttempted = false;
    if (failedRun) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { isEligibleForRetry } = require("./childRetry") as typeof import("./childRetry");
        retryWillBeAttempted = "nextAttempt" in isEligibleForRetry(taskId, failedRun);
      } catch (e) {
        logError("auto-retry", "eligibility pre-check crashed", e, { tag });
      }
    }

    if (!retryWillBeAttempted) {
      releaseRepoReservation(repo, sessionId);
    }
    logError("lifecycle", `run failed: ${reason}`, undefined, { tag });
    if (failedRun) tryAutoRetry(failedRun, exitCode);
  };

  const succeedRun = async () => {
    let finishedRun: Run | null = null;
    let taskTitle = "";
    try {
      const meta = readMeta(sessionsDir);
      const run = meta?.runs.find((r) => r.sessionId === sessionId);
      if (run && run.status === "running") {
        const app = getApp(run.repo);
        const willRunPostExitGate =
          app !== null && run.role !== "coordinator";

        const isCoordWithActiveChildren =
          run.role === "coordinator" &&
          !!meta &&
          meta.runs.some(
            (r) =>
              r.parentSessionId === sessionId &&
              r.sessionId !== sessionId &&
              (r.status === "queued" || r.status === "running"),
          );

        const coordHadChildren =
          run.role === "coordinator" &&
          !!meta &&
          meta.runs.some(
            (r) => r.parentSessionId === sessionId && r.sessionId !== sessionId,
          );
        let isCoordPendingSummary = false;
        if (run.role === "coordinator" && coordHadChildren) {
          try {
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            const cn = require("./coordinatorNudge") as typeof import("./coordinatorNudge");
            isCoordPendingSummary = cn.isSummaryMissing(taskId);
          } catch (e) {
            logWarn("lifecycle", "coordinatorNudge.isSummaryMissing unavailable; flipping coordinator without summary check", { tag, error: (e as Error).message });
          }
        }

        if (
          !willRunPostExitGate &&
          !isCoordWithActiveChildren &&
          !isCoordPendingSummary
        ) {
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

    if (finishedRun && finishedRun.role === "coordinator") {
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const cn = require("./coordinatorNudge") as typeof import("./coordinatorNudge");
        cn.scheduleCoordinatorEvaluation(taskId, sessionId, "lifecycle-exit");
      } catch (e) {
        logError("lifecycle", "coordinator nudge scheduling failed", e, { tag });
      }
    }

    if (finishedRun && finishedRun.role.toLowerCase().startsWith("planner")) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { resolvePlanGateAfterPlanner } = require("./planGateLifecycle") as typeof import("./planGateLifecycle");
        void resolvePlanGateAfterPlanner({
          taskId,
          sessionsDir,
          plannerSessionId: finishedRun.sessionId,
        });
      } catch (e) {
        logError("lifecycle", "plan-gate planner-exit hook failed", e, { tag });
      }
    }

    if (finishedRun && finishedRun.role !== "coordinator") {
      void postExitFlow({
        sessionsDir,
        taskId,
        tag,
        finishedRun,
        taskTitle,
      }).then(
        (result) => {
          if (result.releaseReservation) releaseRepoReservation(repo, sessionId);
        },
        async (err) => {
          logError("post-exit", "flow crashed", err, { tag });
          try {
            await updateRun(
              sessionsDir,
              sessionId,
              { status: "failed", endedAt: new Date().toISOString() },
              (r) => r.status === "running",
            );
          } catch (e) {
            logError("post-exit", "safety-net status:failed flip failed", e, { tag });
          }
          releaseRepoReservation(repo, sessionId);
        },
      );
    } else {
      releaseRepoReservation(repo, sessionId);
    }
  };

  child.once("error", (err) => {
    void failRun(`spawn error: ${err.message}`, null);
    setImmediate(() => {
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { cleanupSessionSettings } = require("./permissionSettings") as typeof import("./permissionSettings");
        cleanupSessionSettings(sessionId);
      } catch { }
    });
  });
  child.once("exit", (code, signal) => {
    if (code === 0) {
      void succeedRun();
    } else if (code !== null) {
      void failRun(`exit code ${code}`, code);
    } else {
      void failRun(`killed by signal ${signal ?? "unknown"}`, null);
    }
    setImmediate(() => {
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { cleanupSessionSettings } = require("./permissionSettings") as typeof import("./permissionSettings");
        cleanupSessionSettings(sessionId);
      } catch { }
    });
  });
}
