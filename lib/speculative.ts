/**
 * Speculative dispatch winner selection.
 *
 * Called from `coordinator.ts:postExitFlow` AFTER all post-exit gates
 * (verify chain, claim-vs-diff verifier, style critic, semantic verifier)
 * have passed for the just-finished run. If the run is part of a
 * speculative group (set on `Run.speculativeGroup` at dispatch time),
 * we atomically:
 *
 *   1. Read meta under the per-task lock.
 *   2. If no sibling has claimed `speculativeOutcome: "won"` yet, mark
 *      THIS run as the winner. Then mark every other sibling as
 *      `speculativeOutcome: "lost"` and SIGTERM-kill any still-running
 *      ones. Their worktrees get removed (no merge — only the winner
 *      merges its work back).
 *   3. If a sibling already won, mark THIS run as "lost", remove its
 *      worktree, and signal the caller to skip auto-commit + merge.
 *
 * Returns `{ proceed: true }` when the caller should continue with
 * auto-commit / merge (the run won), or `{ proceed: false }` when it
 * should bail (the run lost OR the run isn't part of a speculative
 * group, in which case proceed is true). The callers never throws;
 * partial-state failures are logged and the safer path is chosen.
 */
import { join } from "node:path";
import { readMeta, updateRun, withTaskLock, type Run } from "./meta";
import { SESSIONS_DIR } from "./paths";
import { killChild } from "./spawnRegistry";
import { removeWorktree } from "./worktrees";
import { getApp } from "./apps";

export interface ClaimResult {
  /** True when the caller should keep going (won OR not speculative). */
  proceed: boolean;
  /** "won" / "lost" / "n/a" — useful for logs at the call site. */
  outcome: "won" | "lost" | "n/a";
  /** Sibling sessionIds we killed (winners only). Empty otherwise. */
  killed: string[];
  /** Reason for the result, suitable for one-line log output. */
  reason: string;
}

/**
 * Find every run in the same speculative group, including this one.
 * The lookup is local to a single readMeta call so the result is
 * consistent within the per-task lock.
 */
function siblingsOf(meta: { runs: Run[] }, run: Run): Run[] {
  if (!run.speculativeGroup) return [run];
  return meta.runs.filter((r) => r.speculativeGroup === run.speculativeGroup);
}

export async function claimSpeculativeWinner(args: {
  taskId: string;
  run: Run;
}): Promise<ClaimResult> {
  const { taskId, run } = args;
  if (!run.speculativeGroup) {
    return { proceed: true, outcome: "n/a", killed: [], reason: "not speculative" };
  }
  const sessionsDir = join(SESSIONS_DIR, taskId);

  // Atomic claim under the per-task lock. We can't compose two
  // updateRun() calls without a race; this whole decision must hold
  // the lock from "read meta" through "patch winner + losers" so a
  // racing sibling can never see the same `none-won-yet` snapshot.
  const decision = await withTaskLock(sessionsDir, () => {
    const meta = readMeta(sessionsDir);
    if (!meta) {
      return {
        kind: "skip" as const,
        reason: "meta.json missing",
      };
    }
    const group = siblingsOf(meta, run);
    const existingWinner = group.find(
      (r) => r.speculativeOutcome === "won" && r.sessionId !== run.sessionId,
    );
    if (existingWinner) {
      return {
        kind: "lost" as const,
        winnerId: existingWinner.sessionId,
        reason: `sibling ${existingWinner.sessionId.slice(0, 8)} already won`,
      };
    }
    // First to claim — we win. Don't write yet; the caller's
    // updateRun() does the actual patch outside the lock so this
    // helper's side effects are clearer. We DO need to mark losers
    // here (atomically) so a slower-but-still-passing sibling can't
    // claim "won" between our read and our patch.
    const losers = group.filter((r) => r.sessionId !== run.sessionId);
    return {
      kind: "won" as const,
      losers,
      reason: `winner of group ${run.speculativeGroup} (${group.length} siblings)`,
    };
  });

  if (decision.kind === "skip") {
    return {
      proceed: true,
      outcome: "n/a",
      killed: [],
      reason: decision.reason,
    };
  }

  if (decision.kind === "lost") {
    // Mark self lost. Best-effort worktree cleanup so the loser
    // doesn't leave a stale dir behind.
    try {
      await updateRun(sessionsDir, run.sessionId, {
        speculativeOutcome: "lost",
      });
    } catch (err) {
      console.warn(
        `[speculative] failed to mark loser ${run.sessionId}:`,
        err,
      );
    }
    if (run.worktreePath) {
      const app = getApp(run.repo);
      if (app) {
        try {
          await removeWorktree({
            appPath: app.path,
            worktreePath: run.worktreePath,
          });
        } catch (err) {
          console.warn(
            `[speculative] worktree cleanup for loser ${run.sessionId} failed:`,
            err,
          );
        }
      }
    }
    return {
      proceed: false,
      outcome: "lost",
      killed: [],
      reason: decision.reason,
    };
  }

  // We won. Patch self first, then deal with losers.
  try {
    await updateRun(sessionsDir, run.sessionId, {
      speculativeOutcome: "won",
    });
  } catch (err) {
    console.warn(
      `[speculative] failed to mark winner ${run.sessionId}:`,
      err,
    );
  }

  // Kill + clean up siblings. We track which kills succeeded for the
  // log, but a kill failure is non-fatal — the lifecycle hook on the
  // sibling will eventually fire and we already marked it as lost.
  const killed: string[] = [];
  for (const loser of decision.losers) {
    // Mark "lost" first. This patches `speculativeOutcome` only — the
    // sibling's status (running / done / failed) is left to its own
    // lifecycle hook so we don't race a still-running gate.
    try {
      await updateRun(sessionsDir, loser.sessionId, {
        speculativeOutcome: "lost",
      });
    } catch (err) {
      console.warn(
        `[speculative] failed to mark loser ${loser.sessionId}:`,
        err,
      );
    }
    // Kill if still alive. killChild is idempotent; returns false when
    // the registry has nothing for this id (already exited / never
    // registered locally — e.g. this bridge restarted mid-flight).
    let didKill = false;
    if (loser.status === "queued" || loser.status === "running") {
      try {
        didKill = killChild(loser.sessionId);
      } catch (err) {
        console.warn(`[speculative] kill ${loser.sessionId} threw:`, err);
      }
    }
    if (didKill) killed.push(loser.sessionId);
    // Worktree cleanup — even when the kill failed (orphaned process)
    // we want the worktree gone so it doesn't pile up. The sibling's
    // own lifecycle would have cleaned it after a successful win, but
    // since it lost, no merge happens — just remove.
    if (loser.worktreePath) {
      const app = getApp(loser.repo);
      if (app) {
        try {
          await removeWorktree({
            appPath: app.path,
            worktreePath: loser.worktreePath,
          });
        } catch (err) {
          console.warn(
            `[speculative] worktree cleanup for loser ${loser.sessionId} failed:`,
            err,
          );
        }
      }
    }
  }

  return {
    proceed: true,
    outcome: "won",
    killed,
    reason: decision.reason,
  };
}
