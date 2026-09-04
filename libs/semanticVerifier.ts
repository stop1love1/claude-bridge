import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { appendRun, readMeta, type Run, type RunSemanticVerifier } from "./meta";
import { wireRunLifecycle } from "./coordinator";
import { resolveRepoCwd } from "./repos";
import { denyTaskToolNames, spawnFreeSession } from "./spawn";
import { releaseRepoReservation, transferRepoReservation } from "./repoReservation";
import {
  freeSessionSettingsPath,
  writeSessionSettings,
} from "./permissionSettings";
import { readOriginalPrompt } from "./promptStore";
import { runAgentGate, type AgentGateOutcome } from "./qualityGate";
import {
  runGatePanel,
  aggregatePanel,
  type PanelLens,
  type PanelVote,
} from "./judgePanel";
import { inheritWorktreeFields } from "./worktrees";
import { BRIDGE_ROOT, SESSIONS_DIR, readBridgeMd } from "./paths";
import { getApp, resolvePanelSize } from "./apps";
import {
  checkEligibility,
  maxAttemptsFor,
  nextRetryRole,
  parseRole,
  renderStrategyPrefix,
} from "./retryLadder";
import { logError, logWarn } from "./log";

export const SEMANTIC_VERIFIER_ROLE = "semantic-verifier";
export const SEMANTIC_VERIFIER_RETRY_SUFFIX = "-svretry";
const VERDICT_FILE = "semantic-verifier-verdict.json";
const CONCERNS_CAP = 10;

export const SEMANTIC_LENSES: PanelLens[] = [
  {
    key: "correctness",
    nudge:
      "Judge ONLY whether the diff satisfies the task body's acceptance criteria. Does it deliver what was asked, end to end?",
  },
  {
    key: "edge-cases",
    nudge:
      "Hunt for an input or state the diff handles WRONG — empty/boundary/error paths, off-by-one, missing null guards. Try to break it; if you find a real gap, verdict `broken`.",
  },
  {
    key: "regression",
    nudge:
      "Judge whether this change breaks EXISTING behavior or opens an input/boundary/security risk elsewhere in the codebase. Look beyond the touched lines.",
  },
];

export interface RunSemanticVerifierOptions {
  appPath: string;
  taskId: string;
  finishedRun: Run;
  taskTitle: string;
  taskBody: string;
}

const BRIEF_BODY = [
  "Re-read the `## Task` section above (the user's original request) and the prior agent's report at `<bridge>/sessions/<task>/reports/<role>-<repo>.md`. Cross-check `git diff HEAD` against the task body's acceptance criteria — does the diff actually accomplish what was asked?",
  "",
  "Write the verdict file before exiting. The bridge reads it directly to decide whether to gate the commit.",
].join("\n");

export function parseSemanticVerdict(
  raw: unknown,
): {
  verdict: "pass" | "drift" | "broken";
  reason: string;
  concerns: string[];
} | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;

  const v = r.verdict;
  if (v !== "pass" && v !== "drift" && v !== "broken") return null;

  const reason =
    typeof r.reason === "string" && r.reason.trim().length > 0
      ? r.reason.trim().slice(0, 400)
      : "(no reason provided)";

  const concernsRaw = Array.isArray(r.concerns) ? r.concerns : [];
  const concerns = concernsRaw
    .filter((c): c is string => typeof c === "string" && c.trim().length > 0)
    .map((c) => c.trim().slice(0, 400))
    .slice(0, CONCERNS_CAP);

  return { verdict: v, reason, concerns };
}

export async function runSemanticVerifier(
  opts: RunSemanticVerifierOptions,
): Promise<RunSemanticVerifier> {
  const start = Date.now();
  const skipped = (
    reason: string,
    sessionId?: string | null,
  ): RunSemanticVerifier => ({
    verdict: "skipped",
    reason,
    concerns: [],
    verifierSessionId: sessionId ?? null,
    durationMs: Date.now() - start,
  });

  const app = getApp(opts.finishedRun.repo);
  const panelSize = resolvePanelSize(app ?? { quality: {} }, SEMANTIC_LENSES.length);

  if (panelSize === 1) {
    const outcome: AgentGateOutcome = await runAgentGate({
      appPath: opts.appPath,
      taskId: opts.taskId,
      finishedRun: opts.finishedRun,
      taskTitle: opts.taskTitle,
      taskBody: opts.taskBody,
      role: SEMANTIC_VERIFIER_ROLE,
      briefBody: BRIEF_BODY,
      verdictFileName: VERDICT_FILE,
    });
    if (outcome.kind === "skipped") {
      return skipped(outcome.reason, outcome.sessionId ?? null);
    }
    const parsed = parseSemanticVerdict(outcome.verdict);
    if (!parsed) {
      return skipped(
        "verdict file did not match `{verdict, reason, concerns}` schema",
        outcome.sessionId,
      );
    }
    return {
      verdict: parsed.verdict,
      reason: parsed.reason,
      concerns: parsed.concerns,
      verifierSessionId: outcome.sessionId,
      durationMs: Date.now() - start,
      panelSize: 1,
    };
  }

  const lenses = SEMANTIC_LENSES.slice(0, panelSize);
  const results = await runGatePanel({
    appPath: opts.appPath,
    taskId: opts.taskId,
    finishedRun: opts.finishedRun,
    taskTitle: opts.taskTitle,
    taskBody: opts.taskBody,
    role: SEMANTIC_VERIFIER_ROLE,
    baseBrief: BRIEF_BODY,
    verdictFilePrefix: "semantic-verdict",
    lenses,
  });

  const votes: PanelVote[] = [];
  let firstSessionId: string | null = null;
  for (const { lens, outcome } of results) {
    if (outcome.kind !== "spawned") continue;
    firstSessionId = firstSessionId ?? outcome.sessionId;
    const parsed = parseSemanticVerdict(outcome.verdict);
    if (!parsed) continue;
    votes.push({
      lens,
      verdict: parsed.verdict,
      reason: parsed.reason,
      concerns: parsed.concerns,
    });
  }

  const agg = aggregatePanel(votes, lenses.length);
  return {
    verdict: agg.verdict,
    reason: agg.reason,
    concerns: agg.concerns,
    verifierSessionId: firstSessionId,
    durationMs: Date.now() - start,
    panelSize: lenses.length,
    votes: votes.map((v) => ({ lens: v.lens, verdict: v.verdict, reason: v.reason })),
  };
}

export function renderSemanticRetryContextBlock(
  verifier: RunSemanticVerifier,
): string {
  const lines: string[] = [
    "## Auto-retry context — what failed last time",
    "",
    "The previous attempt exited cleanly and the inline verifier passed, but the bridge's semantic verifier judged the diff as not accomplishing the task. Re-read the task body and address the concerns below — the goal is delivering what was asked, not just touching the right files.",
    "",
    `### Verdict: ${verifier.verdict.toUpperCase()}`,
    `**Reason:** ${verifier.reason}`,
    "",
  ];
  if (verifier.concerns.length > 0) {
    lines.push(
      "### Concerns",
      ...verifier.concerns.map((c) => `- ${c}`),
      "",
    );
  }
  lines.push(
    "Re-read the `## Task` section of this prompt — the original request is the ground truth, not your prior report. After fixing, write a fresh report; the bridge will re-run the verifier on this attempt and `pass`/`drift` gates the auto-commit.",
    "",
  );
  return lines.join("\n");
}

export function isEligibleForSemanticVerifierRetry(args: {
  finishedRun: Run;
  meta: { runs: Run[] };
  retry?: import("./apps").AppRetry;
}): boolean {
  return checkEligibility({
    finishedRun: args.finishedRun,
    meta: args.meta,
    gate: "semantic",
    retry: args.retry,
  }).eligible;
}

export async function spawnSemanticVerifierRetry(args: {
  taskId: string;
  finishedRun: Run;
  verifier: RunSemanticVerifier;
}): Promise<{ sessionId: string; run: Run } | null> {
  const { taskId, finishedRun, verifier } = args;
  const sessionsDir = join(SESSIONS_DIR, taskId);

  const md = readBridgeMd();
  const liveRepoCwd = resolveRepoCwd(md, BRIDGE_ROOT, finishedRun.repo);
  if (!liveRepoCwd) return null;
  const spawnCwd = finishedRun.worktreePath ?? liveRepoCwd;

  const app = getApp(finishedRun.repo);
  const meta = readMeta(sessionsDir);
  if (!meta) return null;
  const elig = checkEligibility({
    finishedRun,
    meta,
    gate: "semantic",
    retry: app?.retry,
  });
  if (!elig.eligible) return null;
  const parsed = parseRole(finishedRun.role);
  const maxAttempts = maxAttemptsFor(app?.retry, "semantic");

  const strategyPrefix = renderStrategyPrefix({
    gate: "semantic",
    attempt: elig.nextAttempt,
    maxAttempts,
  });
  const ctxBlock = renderSemanticRetryContextBlock(verifier);
  const originalPrompt = readOriginalPrompt(taskId, finishedRun);
  const body =
    originalPrompt.trim() ||
    "(original prompt unavailable — repo state and the failure context above are the only signals you have. Re-read the task body and the prior report, identify the gap, and re-attempt.)";
  const retryPrompt = [strategyPrefix, ctxBlock, "---", "", body].join("\n");

  const sessionId = randomUUID();

  const canTransferReservation = !!app && !finishedRun.worktreePath;
  if (canTransferReservation) {
    const transfer = transferRepoReservation(finishedRun.repo, finishedRun.sessionId, sessionId);
    if (!transfer.ok) {
      logWarn(
        "semantic-verifier",
        `semantic-retry could not transfer ${finishedRun.repo} reservation to retry session (held by ${transfer.heldBy}) — proceeding anyway`,
        { taskId, sessionId: finishedRun.sessionId },
      );
    }
  }

  let childHandle;
  let retryRun: Run;
  try {
    const settingsPath = writeSessionSettings(freeSessionSettingsPath(sessionId));
    childHandle = spawnFreeSession(
      spawnCwd,
      retryPrompt,
      { mode: "bypassPermissions", disallowedTools: denyTaskToolNames() },
      settingsPath,
      sessionId,
    );
    retryRun = {
      sessionId,
      role: nextRetryRole(parsed.baseRole, "semantic", elig.nextAttempt),
      repo: finishedRun.repo,
      status: "running",
      startedAt: new Date().toISOString(),
      endedAt: null,
      parentSessionId: finishedRun.parentSessionId ?? null,
      retryOf: finishedRun.sessionId,
      retryAttempt: elig.nextAttempt,
      ...inheritWorktreeFields(finishedRun),
    };
    await appendRun(sessionsDir, retryRun);
  } catch (e) {
    logError(
      "semantic-verifier",
      "semantic-retry spawn failed",
      e,
      { taskId, sessionId: finishedRun.sessionId },
    );
    if (canTransferReservation) releaseRepoReservation(finishedRun.repo, sessionId);
    return null;
  }

  wireRunLifecycle(
    sessionsDir,
    sessionId,
    childHandle.child,
    finishedRun.repo,
    `semantic-retry ${taskId}/${sessionId}`,
  );
  return { sessionId, run: retryRun };
}
