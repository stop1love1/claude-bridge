import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { randomUUID } from "node:crypto";
import type { ChildProcess } from "node:child_process";
import { BRIDGE_FOLDER, BRIDGE_LOGIC_DIR, BRIDGE_ROOT, BRIDGE_URL, SESSIONS_DIR } from "./paths";
import {
  appendRun,
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
import { spawnClaude } from "./spawn";
// Type-only imports — runtime side resolves via lazy `require` inside
// the post-exit flow to break the import cycle (verifyChain.ts,
// verifier.ts, preflightCheck.ts, styleCritic.ts, and
// semanticVerifier.ts all import `wireRunLifecycle` from this file).
import type * as VerifyChain from "./verifyChain";
import type * as Verifier from "./verifier";
import type * as Preflight from "./preflightCheck";
import type * as StyleCritic from "./styleCritic";
import type * as SemanticVerifier from "./semanticVerifier";

/**
 * Lazy bridges to the post-exit-flow modules. Same pattern as the
 * `childRetry` require inside `tryAutoRetry` below — we MUST NOT eagerly
 * import these at the top of this file because they import
 * `wireRunLifecycle` from here, and the cycle would leave one side
 * seeing `undefined` exports during init.
 */
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
import type { Task } from "./tasks";
import { loadProfiles } from "./profileStore";
import { resolveRepoCwd, resolveRepos } from "./repos";
import { readBridgeMd } from "./paths";
import { getApp } from "./apps";
import {
  autoCommitAndPush,
  mergeIntoTargetBranch,
  readCurrentBranch,
} from "./gitOps";
import { mergeAndRemoveWorktree } from "./worktrees";
import { runDevopsAgent } from "./devops";
import {
  getOrComputeScope,
  loadDetectInput,
  renderDetectedScope,
} from "./detect";

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
      // Lazy import: childRetry → coordinator (this file) → … breaks
      // the cycle if loaded eagerly at module top.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { maybeScheduleRetry } = require("./childRetry") as typeof import("./childRetry");
      maybeScheduleRetry({ taskId, failedRun, exitCode });
    } catch (e) {
      console.error("auto-retry hook crashed for", tag, e);
    }
  };

  const failRun = async (reason: string, exitCode: number | null) => {
    try {
      const meta = readMeta(sessionsDir);
      const run = meta?.runs.find((r) => r.sessionId === sessionId);
      if (run && run.status === "running") {
        await updateRun(sessionsDir, sessionId, {
          status: "failed",
          endedAt: new Date().toISOString(),
        });
      }
    } catch (e) {
      console.error("failed to mark run failed for", tag, e);
    }
    console.error("run failed for", tag, reason);
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
        if (!willRunPostExitGate) {
          await updateRun(sessionsDir, sessionId, {
            status: "done",
            endedAt: new Date().toISOString(),
          });
        }
      }
      if (run && meta) {
        finishedRun = run;
        taskTitle = meta.taskTitle;
      }
    } catch (e) {
      console.error("failed to mark run done for", tag, e);
    }

    // P2 — verify chain + commit gate. Wrapped in an async IIFE so the
    // `child.on("exit", ...)` handler stays sync; rejections surface via
    // .catch() rather than crashing the Next.js dev server (Risk 1).
    if (finishedRun && finishedRun.role !== "coordinator") {
      void postExitFlow({
        sessionsDir,
        taskId,
        tag,
        finishedRun,
        taskTitle,
      }).catch((err) => {
        console.error(`post-exit flow crashed for ${tag}`, err);
      });
    }
  };

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
    const vc = loadVerifyChain();
    const verifyCfg = vc.verifyConfigOf(app);
    const willRunVerify =
      app !== null &&
      vc.hasAnyVerifyCommand(verifyCfg) &&
      !vc.isAlreadyRetryRun(run.role);

    let verifyResult: RunVerify | null = null;
    if (willRunVerify && verifyCfg && app) {
      try {
        verifyResult = await vc.runVerifyChain({
          // P4: run the verify chain inside the run's worktree when
          // present so it tests the agent's actual edits, not the live
          // tree's pre-spawn state.
          cwd: run.worktreePath ?? app.path,
          verify: verifyCfg,
        });
      } catch (err) {
        console.error(`verify chain crashed for ${t}`, err);
        verifyResult = null;
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

      const meta = readMeta(dir);
      const r = meta?.runs.find((x) => x.sessionId === run.sessionId);
      if (r && r.status === "running") {
        await updateRun(dir, run.sessionId, {
          status: "done",
          endedAt: new Date().toISOString(),
          verify: finalVerify,
        });
      } else if (finalVerify) {
        // Status was already flipped (rare race); still attach verify.
        await updateRun(dir, run.sessionId, { verify: finalVerify });
      }

      if (verifyResult && !verifyResult.passed) {
        const failedName = verifyResult.steps.find((s: RunVerifyStep) => !s.ok)?.name;
        if (scheduledRetry) {
          // Fire the SSE retried event so AgentTree draws the retryOf
          // arrow — same contract as crash-retry path emits via
          // childRetry.maybeScheduleRetry → emitRetried.
          emitRetried(tid, scheduledRetry.run, run.sessionId);
          console.log(
            `[verify] ${t}: chain failed at \`${failedName}\` — spawned retry ${scheduledRetry.sessionId}`,
          );
        } else {
          console.log(
            `[verify] ${t}: chain failed at \`${failedName}\` — retry ineligible / already attempted`,
          );
        }
        // Verify failed → block the auto-commit. The retry (if any) will
        // re-trigger this whole flow when it exits.
        return;
      }
    }

    // P3b/B1 — preflight check: did the agent actually read enough of
    // the codebase before editing? Runs BEFORE the verifier (claim-vs-
    // diff) because if the agent didn't follow process, there's no
    // point comparing claims that come from process drift. Reuses the
    // -cretry suffix and budget — a single follow-up per (parent, role)
    // covers either preflight OR claim-vs-diff failures, since both
    // signal "agent didn't follow process". The outer `!isAlreadyRetryRun`
    // guard mirrors the verify-chain branch's gate (line 178); without
    // it, future drift in `runPreflight`'s internal retry skip would
    // open an infinite-retry footgun.
    const vcGuard = loadVerifyChain();
    if (app && !vcGuard.isAlreadyRetryRun(run.role)) {
      const pf = loadPreflight();
      // Resolve repoCwd the same way `agents/route.ts` did at spawn time.
      // The child's `.jsonl` lives under `projectDirFor(repoCwd)` —
      // using `app.path` instead can land us in a different slug if
      // BRIDGE.md and `bridge.json` happen to spell the same dir
      // differently (case, symlinks, trailing slash). Fall back to
      // `app.path` when BRIDGE.md is missing — preflight will then
      // skip silently if the slug differs.
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
        console.error(`preflight crashed for ${t}`, err);
      }

      if (preflightResult && preflightResult.verdict === "fail") {
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
        // field for preflight, just piggyback on the verifier slot
        // since the post-exit gate semantics are equivalent).
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
        const metaNow = readMeta(dir);
        const r = metaNow?.runs.find((x) => x.sessionId === run.sessionId);
        if (r && r.status === "running") {
          await updateRun(dir, run.sessionId, {
            status: "done",
            endedAt: new Date().toISOString(),
            verifier: finalVerifier,
          });
        } else {
          await updateRun(dir, run.sessionId, { verifier: finalVerifier });
        }

        if (scheduledPreflightRetry) {
          emitRetried(tid, scheduledPreflightRetry.run, run.sessionId);
          console.log(
            `[preflight] ${t}: ${preflightResult.reason} — spawned retry ${scheduledPreflightRetry.sessionId}`,
          );
        } else {
          console.log(
            `[preflight] ${t}: ${preflightResult.reason} — retry ineligible / already attempted`,
          );
        }
        return;
      }
    }

    // P2b-1 — inline claim-vs-diff verifier. Runs only when the verify
    // chain didn't write a failing result (we'd already have returned
    // above) AND the run has an app to diff against. The verifier is
    // cheap (parse markdown + git status + set diff) so it's always-on
    // for app runs that aren't themselves retries.
    if (app) {
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
        console.error(`verifier crashed for ${t}`, err);
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

      // Combined patch: include status:done flip when the run is still
      // "running" (i.e. succeedRun deferred it because we knew the
      // verifier would write meta anyway). When verify chain ran first
      // and already flipped status, the if-branch below skips that
      // field — the verifier-only patch still lands. Both updateRun
      // calls MUST be awaited so we don't race autoCommitAndPush /
      // appendRun for the cretry sibling.
      if (finalVerifier) {
        const metaNow = readMeta(dir);
        const r = metaNow?.runs.find((x) => x.sessionId === run.sessionId);
        if (r && r.status === "running") {
          await updateRun(dir, run.sessionId, {
            status: "done",
            endedAt: new Date().toISOString(),
            verifier: finalVerifier,
          });
        } else {
          await updateRun(dir, run.sessionId, { verifier: finalVerifier });
        }
      }

      if (needsClaimRetry && verifierResult) {
        if (scheduledClaimRetry) {
          emitRetried(tid, scheduledClaimRetry.run, run.sessionId);
          console.log(
            `[verifier] ${t}: ${verifierResult.verdict} — ${verifierResult.reason} — spawned retry ${scheduledClaimRetry.sessionId}`,
          );
        } else {
          console.log(
            `[verifier] ${t}: ${verifierResult.verdict} — ${verifierResult.reason} — retry ineligible / already attempted`,
          );
        }
        // Block the auto-commit; the retry (if any) re-enters this
        // whole flow when it exits.
        return;
      }
    }

    // P2b-2 — agent-driven style critic. Opt-in per app via
    // `bridge.json.apps[].quality.critic`. Runs only when the inline
    // verifier didn't trigger a retry above, the run isn't already a
    // retry, and the app exists. Blocking is gated on `alien` only —
    // `match` and `drift` both ship.
    if (
      app &&
      app.quality?.critic === true &&
      !vcGuard.isAlreadyRetryRun(run.role)
    ) {
      const sc = loadStyleCritic();
      let criticResult: RunStyleCritic | null = null;
      try {
        criticResult = await sc.runStyleCritic({
          // P4: gate runs in the same worktree the coder did so it sees
          // the agent's diff via `git diff HEAD`. Falls back to the
          // live tree when worktree mode is off.
          appPath: run.worktreePath ?? app.path,
          taskId: tid,
          finishedRun: run,
          taskTitle: title,
          taskBody: readMeta(dir)?.taskBody ?? "",
        });
      } catch (err) {
        console.error(`style-critic crashed for ${t}`, err);
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
        const metaNow = readMeta(dir);
        const r = metaNow?.runs.find((x) => x.sessionId === run.sessionId);
        if (r && r.status === "running") {
          await updateRun(dir, run.sessionId, {
            status: "done",
            endedAt: new Date().toISOString(),
            styleCritic: finalCritic,
          });
        } else {
          await updateRun(dir, run.sessionId, { styleCritic: finalCritic });
        }
      }

      if (needsStyleRetry && criticResult) {
        if (scheduledStyleRetry) {
          emitRetried(tid, scheduledStyleRetry.run, run.sessionId);
          console.log(
            `[style-critic] ${t}: ${criticResult.verdict} — ${criticResult.reason} — spawned retry ${scheduledStyleRetry.sessionId}`,
          );
        } else {
          console.log(
            `[style-critic] ${t}: ${criticResult.verdict} — ${criticResult.reason} — retry ineligible / already attempted`,
          );
        }
        // Block the auto-commit; the retry re-enters this whole flow.
        return;
      }
    }

    // P2b-2 — agent-driven semantic verifier. Opt-in per app via
    // `bridge.json.apps[].quality.verifier`. Runs only when the prior
    // gates didn't trigger a retry. Blocking is gated on `broken` only.
    if (
      app &&
      app.quality?.verifier === true &&
      !vcGuard.isAlreadyRetryRun(run.role)
    ) {
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
        console.error(`semantic-verifier crashed for ${t}`, err);
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
        const metaNow = readMeta(dir);
        const r = metaNow?.runs.find((x) => x.sessionId === run.sessionId);
        if (r && r.status === "running") {
          await updateRun(dir, run.sessionId, {
            status: "done",
            endedAt: new Date().toISOString(),
            semanticVerifier: finalSemantic,
          });
        } else {
          await updateRun(dir, run.sessionId, {
            semanticVerifier: finalSemantic,
          });
        }
      }

      if (needsSemanticRetry && semanticResult) {
        if (scheduledSemanticRetry) {
          emitRetried(tid, scheduledSemanticRetry.run, run.sessionId);
          console.log(
            `[semantic-verifier] ${t}: ${semanticResult.verdict} — ${semanticResult.reason} — spawned retry ${scheduledSemanticRetry.sessionId}`,
          );
        } else {
          console.log(
            `[semantic-verifier] ${t}: ${semanticResult.verdict} — ${semanticResult.reason} — retry ineligible / already attempted`,
          );
        }
        return;
      }
    }

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
          console.log(`auto-git for ${t}: ${r.message}`);
        } else {
          console.warn(`auto-git for ${t}: ${r.message} — ${r.error ?? ""}`);
        }
      } catch (err) {
        console.error(`auto-git crashed for ${t}`, err);
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
          console.warn(
            `integration skipped for ${t}: detached HEAD or non-git tree at ${commitCwd}`,
          );
        } else if (app.git.integrationMode === "auto-merge") {
          const m = await mergeIntoTargetBranch({
            cwd: commitCwd,
            sourceBranch,
            targetBranch: app.git.mergeTargetBranch,
            message: `merge ${sourceBranch} → ${app.git.mergeTargetBranch} (${tid})`,
            push: app.git.autoPush,
          });
          if (m.ok) {
            console.log(`auto-merge for ${t}: ${m.message}`);
          } else {
            console.warn(
              `auto-merge for ${t}: ${m.message} — ${m.error ?? ""}`,
            );
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
          const tag = `pull-request for ${t}`;
          if (d.status === "opened" || d.status === "exists") {
            console.log(`${tag}: ${d.status} — ${d.url ?? "(no url)"} (${d.reason})`);
          } else {
            console.warn(`${tag}: ${d.status} — ${d.reason}`);
          }
        }
      } catch (err) {
        console.error(`integration crashed for ${t}`, err);
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
          console.warn(
            `[worktree] cleanup for ${t}: ${wm.message} — ${wm.error ?? ""}`,
          );
        } else {
          console.log(`[worktree] cleanup for ${t}: ${wm.message}`);
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
              console.log(`auto-merge for ${t}: ${m.message}`);
            } else {
              console.warn(
                `auto-merge for ${t}: ${m.message} — ${m.error ?? ""}`,
              );
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
            const tag = `pull-request for ${t}`;
            if (d.status === "opened" || d.status === "exists") {
              console.log(
                `${tag}: ${d.status} — ${d.url ?? "(no url)"} (${d.reason})`,
              );
            } else {
              console.warn(`${tag}: ${d.status} — ${d.reason}`);
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
            console.log(`auto-push (live tree) for ${t}: ${r.message}`);
          } else {
            console.warn(
              `auto-push (live tree) for ${t}: ${r.message} — ${r.error ?? ""}`,
            );
          }
        }
      } catch (err) {
        console.error(`[worktree] cleanup crashed for ${t}`, err);
      }
    }
  }

  child.on("error", (err) => {
    void failRun(`spawn error: ${err.message}`, null);
  });
  child.on("exit", (code) => {
    if (code === 0) {
      void succeedRun();
    } else if (code !== null) {
      void failRun(`exit code ${code}`, code);
    }
  });
}

/**
 * Build the canonical `## Detected scope` block for the coordinator.
 * Reads the cached scope from `meta.json` (computed at task creation
 * time by `app/api/tasks/route.ts`). On a cache miss (legacy meta /
 * bridge upgrade mid-flight) computes a fresh scope, persists it, and
 * uses that — the coordinator is never starved of context.
 *
 * Replaces the legacy `## Bridge hint` + `## Repo profiles` pair —
 * one block, same shape children see, no drift.
 */
async function buildDetectedScopeBlock(
  sessionsDir: string,
  task: Pick<Task, "id" | "title" | "body" | "app">,
): Promise<string> {
  try {
    const profiles = loadProfiles()?.profiles ?? undefined;
    const scope = await getOrComputeScope(sessionsDir, () =>
      loadDetectInput({
        taskBody: task.body,
        taskTitle: task.title,
        pinnedRepo: task.app ?? null,
      }),
    );
    return renderDetectedScope(scope, { profiles, forCoordinator: true });
  } catch (err) {
    console.error("buildDetectedScopeBlock failed (non-fatal)", err);
    return [
      "## Detected scope",
      "",
      "_(detection layer crashed — see bridge logs. Fall back to reading the task body and BRIDGE.md repos table directly.)_",
      "",
    ].join("\n");
  }
}

/**
 * Splice the `## Detected scope` block in before the coordinator
 * template's `## Your job` heading. Falls back to prepending when the
 * marker is missing (template shape changed).
 */
function spliceScopeBlock(rendered: string, block: string): string {
  const marker = "## Your job";
  const idx = rendered.indexOf(marker);
  if (idx === -1) return `${block}\n${rendered}`;
  return `${rendered.slice(0, idx)}${block}\n${rendered.slice(idx)}`;
}

export async function spawnCoordinatorForTask(
  task: Pick<Task, "id" | "title" | "body"> & { app?: string | null },
): Promise<string | null> {
  const sessionsDir = join(SESSIONS_DIR, task.id);

  // meta.json is created by `createTask` in tasksStore. If it's missing
  // here something upstream is broken — log and bail rather than spawn
  // an orphan coordinator that can't register itself.
  if (!readMeta(sessionsDir)) {
    console.error("coordinator spawn skipped: meta.json missing for", task.id);
    return null;
  }

  try {
    // Pre-allocate the coordinator's session UUID so we can render it
    // into the prompt template. The coordinator used to have to discover
    // its own session id by listing the newest .jsonl in its project
    // dir, which races against any other claude session active in the
    // same cwd — wrong uuid → wrong run patched to "done" → original
    // bridge-pre-registered run stuck at "running" forever.
    const sessionId = randomUUID();

    const template = readFileSync(join(BRIDGE_LOGIC_DIR, "coordinator.md"), "utf8");
    // Build a one-shot example of `repo` to use in curl snippets so the
    // template doesn't have to hardcode a project-specific name.
    let exampleRepo = BRIDGE_FOLDER;
    try {
      const md = readBridgeMd();
      const declared = resolveRepos(md, BRIDGE_ROOT)
        .filter((r) => existsSync(r.path))
        .map((r) => r.name);
      if (declared.length > 0) exampleRepo = declared[0];
    } catch {
      /* fall back to bridge folder name */
    }

    // Substitute STRUCTURAL placeholders first (template-controlled
    // values), USER CONTENT last. If we ran user content first, a task
    // body containing the literal `{{SESSION_ID}}` would be substituted
    // by the next pass — leaking the real session uuid into a malicious
    // prompt or corrupting the template. By the time `task.title` /
    // `task.body` are inlined, no further `replaceAll` runs over them.
    const baseRendered = template
      .replaceAll("{{SESSION_ID}}", sessionId)
      .replaceAll("{{BRIDGE_URL}}", BRIDGE_URL)
      .replaceAll("{{BRIDGE_FOLDER}}", BRIDGE_FOLDER)
      .replaceAll("{{EXAMPLE_REPO}}", exampleRepo)
      .replaceAll("{{TASK_ID}}", task.id)
      .replaceAll("{{TASK_TITLE}}", task.title)
      .replaceAll("{{TASK_BODY}}", task.body);
    // Inject the canonical `## Detected scope` block — coordinator and
    // every spawned child see the same scope, no drift between the two.
    // Replaces the legacy `## Repo profiles` + `## Bridge hint` pair.
    const scopeBlock = await buildDetectedScopeBlock(sessionsDir, {
      id: task.id,
      title: task.title,
      body: task.body,
      app: task.app ?? null,
    });
    const renderedPrompt = spliceScopeBlock(baseRendered, scopeBlock);

    // Append the run BEFORE spawning — H4 orphan-window fix. If
    // `spawnClaude` throws (claude binary missing, fork EAGAIN, etc.)
    // we still have a tracked `failed` row in meta.json instead of a
    // silent gap. `appendRun` is async (per-task lock from cluster B).
    await appendRun(sessionsDir, {
      sessionId,
      role: "coordinator",
      repo: basename(BRIDGE_ROOT),
      status: "queued",
      startedAt: null,
      endedAt: null,
    });

    let child;
    try {
      ({ child } = spawnClaude(BRIDGE_ROOT, {
        role: "coordinator",
        taskId: task.id,
        prompt: renderedPrompt,
        sessionId,
        // Coordinator runs unattended — there's no TTY for permission
        // prompts. Without this, the first tool call hangs waiting for
        // confirmation and the process eventually exits. The free-chat
        // permission hook is NOT attached here for the same reason.
        settings: { mode: "bypassPermissions" },
      }));
    } catch (spawnErr) {
      try {
        await updateRun(sessionsDir, sessionId, {
          status: "failed",
          endedAt: new Date().toISOString(),
        });
      } catch (uErr) {
        console.error("failed to mark coordinator run failed after spawn error", uErr);
      }
      throw spawnErr;
    }

    // Spawn succeeded — promote queued → running with a real
    // startedAt. `wireRunLifecycle` then handles running → done/failed
    // on child exit. Belt-and-suspenders: if the coordinator finishes
    // cleanly (exit 0) but forgot to PATCH itself to "done" via the
    // link API, the lifecycle hook flips the run.
    try {
      await updateRun(sessionsDir, sessionId, {
        status: "running",
        startedAt: new Date().toISOString(),
      });
    } catch (uErr) {
      console.error("failed to promote coordinator queued → running", uErr);
    }

    wireRunLifecycle(sessionsDir, sessionId, child, `coordinator ${task.id}`);
    return sessionId;
  } catch (err) {
    console.error("coordinator spawn failed for", task.id, err);
    return null;
  }
}
