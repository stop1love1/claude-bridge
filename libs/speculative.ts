import { join } from "node:path";
import { emitRunUpdated, readMeta, withTaskLock, writeMeta, type Run } from "./meta";
import { SESSIONS_DIR } from "./paths";
import { killChild } from "./spawnRegistry";
import { removeWorktree } from "./worktrees";
import { getApp } from "./apps";

export interface ClaimResult {
  proceed: boolean;
  outcome: "won" | "lost" | "n/a";
  killed: string[];
  reason: string;
}

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
      const self = meta.runs.find((r) => r.sessionId === run.sessionId);
      if (self && self.speculativeOutcome !== "lost") {
        const prevStatus = self.status;
        self.speculativeOutcome = "lost";
        writeMeta(sessionsDir, meta);
        emitRunUpdated(sessionsDir, self, prevStatus);
      }
      return {
        kind: "lost" as const,
        winnerId: existingWinner.sessionId,
        reason: `sibling ${existingWinner.sessionId.slice(0, 8)} already won`,
      };
    }
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

  const killed: string[] = [];
  for (const loser of decision.losers) {
    let didKill = false;
    if (loser.status === "queued" || loser.status === "running") {
      try {
        didKill = killChild(loser.sessionId);
      } catch (err) {
        console.warn(`[speculative] kill ${loser.sessionId} threw:`, err);
      }
    }
    if (didKill) killed.push(loser.sessionId);
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
