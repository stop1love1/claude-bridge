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
import { emitRunUpdated, readMeta, withTaskLock, writeMeta, type Run } from "./meta";
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

  // Atomic claim under the per-task lock. The whole decision MUST
  // hold the lock from "read meta" through "patch winner + losers
  // and write meta" — a racing sibling that enters the lock after us
  // must already see our `speculativeOutcome: "won"` mark on disk.
  // Earlier code returned the decision and patched outside the lock;
  // that race let two siblings both claim winner.
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
      // Mark self lost in the same lock+write so the on-disk view of
      // the group is final by the time we release.
      const self = meta.runs.find((r) => r.sessionId === run.sessionId);
      if (self && self.speculativeOutcome !== "lost") {
        const prevStatus = self.status;
        self.speculativeOutcome = "lost";
        writeMeta(sessionsDir, meta);
        // Surface the speculativeOutcome change as an `updated` SSE
        // event so the UI's run chip flips to "lost" without waiting
        // for the next poll cycle. writeMeta alone fires a generic
        // `writeMeta` event with no per-run payload.
        emitRunUpdated(sessionsDir, self, prevStatus);
      }
      return {
        kind: "lost" as const,
        winnerId: existingWinner.sessionId,
        reason: `sibling ${existingWinner.sessionId.slice(0, 8)} already won`,
      };
    }
    // First to claim — we win. Patch self AND every loser in the
    // SAME write so any sibling that enters the lock after us sees a
    // fully-decided group on disk. Without this, a slower-but-still-
    // passing sibling reading meta in their own withTaskLock would
    // see no winner yet and also claim "won".
    const losers = group.filter((r) => r.sessionId !== run.sessionId);
    const self = meta.runs.find((r) => r.sessionId === run.sessionId);
    const changed: Array<{ run: Run; prevStatus: Run["status"] }> = [];
    if (self) {
      changed.push({ run: self, prevStatus: self.status });
      self.speculativeOutcome = "won";
    }
    for (const loser of losers) {
      const lr = meta.runs.find((r) => r.sessionId === loser.sessionId);
      if (lr) {
        changed.push({ run: lr, prevStatus: lr.status });
        lr.speculativeOutcome = "lost";
      }
    }
    writeMeta(sessionsDir, meta);
    // Per-run SSE notifications AFTER the on-disk write so subscribers
    // never observe an event for a row that isn't yet persisted —
    // matches the pattern in applyManyRuns / updateRun.
    for (const c of changed) emitRunUpdated(sessionsDir, c.run, c.prevStatus);
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

  // We won — winner+losers were already patched inside the lock above.
  // Now do the side-effect work: kill siblings + clean up worktrees.
  const killed: string[] = [];
  for (const loser of decision.losers) {
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
