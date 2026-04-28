/**
 * P2b-2 — agent-driven semantic verifier.
 *
 * Spawned in `coordinator.ts:postExitFlow` AFTER the inline verifier
 * AND (if enabled) the style critic decide the diff can ship, only
 * when the target app has opted in via
 * `bridge.json.apps[].quality.verifier = true`. Judges whether the
 * diff actually accomplishes the task body — semantic verification,
 * distinct from the inline verifier's claim-vs-diff honesty check.
 *
 *   verdict = pass     → commit proceeds
 *   verdict = drift    → commit proceeds, surfaced in meta for review
 *   verdict = broken   → block commit, spawn `<role>-svretry` retry
 *   verdict = skipped  → preconditions not met (no playbook, gate
 *                        crashed, no verdict file) — commit proceeds
 *
 * Distinct from `lib/verifier.ts`:
 *   - inline verifier  — "did the agent claim what they actually edited?"
 *   - semantic verifier (this) — "do the edits actually do what the task asked?"
 */
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { appendRun, type Run, type RunSemanticVerifier } from "./meta";
import { wireRunLifecycle } from "./coordinator";
import { resolveRepoCwd } from "./repos";
import { spawnFreeSession } from "./spawn";
import {
  freeSessionSettingsPath,
  writeSessionSettings,
} from "./permissionSettings";
import { readOriginalPrompt } from "./promptStore";
import { isAlreadyRetryRun } from "./verifyChain";
import { runAgentGate, type AgentGateOutcome } from "./qualityGate";
import { inheritWorktreeFields } from "./worktrees";
import { BRIDGE_ROOT, SESSIONS_DIR, readBridgeMd } from "./paths";

export const SEMANTIC_VERIFIER_ROLE = "semantic-verifier";
export const SEMANTIC_VERIFIER_RETRY_SUFFIX = "-svretry";
const VERDICT_FILE = "semantic-verifier-verdict.json";
const CONCERNS_CAP = 10;

export interface RunSemanticVerifierOptions {
  /** Absolute cwd of the target app. */
  appPath: string;
  taskId: string;
  /** The coder run we're verifying. */
  finishedRun: Run;
  taskTitle: string;
  taskBody: string;
}

const BRIEF_BODY = [
  "Re-read the `## Task` section above (the user's original request) and the prior agent's report at `<bridge>/sessions/<task>/reports/<role>-<repo>.md`. Cross-check `git diff HEAD` against the task body's acceptance criteria — does the diff actually accomplish what was asked?",
  "",
  "Write the verdict file before exiting. The bridge reads it directly to decide whether to gate the commit.",
].join("\n");

/**
 * Validate + coerce the agent-supplied JSON. Same defensive shape as
 * `parseCriticVerdict` — returns null when the payload is unusable so
 * the caller falls back to a `skipped` verdict.
 */
export function parseSemanticVerdict(
  raw: unknown,
): {
  verdict: RunSemanticVerifier["verdict"];
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

/**
 * Top-level entry: spawn the verifier agent against the freshly-finished
 * run, wait for it, parse its verdict, and return the populated
 * `RunSemanticVerifier`. Always returns a verdict (never `null`) —
 * `skipped` covers every fail-soft path.
 */
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
  };
}

/**
 * Render the retry-context block prepended to a `-svretry` prompt.
 */
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

/**
 * Eligibility for semantic-verifier retry. Same shape as the other
 * retry-eligibility checks — independent budget keyed on the
 * `-svretry` suffix.
 */
export function isEligibleForSemanticVerifierRetry(args: {
  finishedRun: Run;
  meta: { runs: Run[] };
}): boolean {
  const { finishedRun, meta } = args;
  if (!finishedRun.parentSessionId) return false;
  if (isAlreadyRetryRun(finishedRun.role)) return false;
  const expected = `${finishedRun.role}${SEMANTIC_VERIFIER_RETRY_SUFFIX}`;
  const prior = meta.runs.find(
    (r) =>
      r.parentSessionId === finishedRun.parentSessionId &&
      r.role === expected,
  );
  return !prior;
}

/**
 * Spawn the semantic-retry. Mirrors `styleCritic.spawnStyleCriticRetry`.
 */
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

  const ctxBlock = renderSemanticRetryContextBlock(verifier);
  const originalPrompt = readOriginalPrompt(taskId, finishedRun);
  const body =
    originalPrompt.trim() ||
    "(original prompt unavailable — repo state and the failure context above are the only signals you have. Re-read the task body and the prior report, identify the gap, and re-attempt.)";
  const retryPrompt = [ctxBlock, "---", "", body].join("\n");

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
    console.error(
      "semantic-retry spawn failed for",
      taskId,
      finishedRun.sessionId,
      e,
    );
    return null;
  }

  const retryRun: Run = {
    sessionId,
    role: `${finishedRun.role}${SEMANTIC_VERIFIER_RETRY_SUFFIX}`,
    repo: finishedRun.repo,
    status: "running",
    startedAt: new Date().toISOString(),
    endedAt: null,
    parentSessionId: finishedRun.parentSessionId ?? null,
    retryOf: finishedRun.sessionId,
    ...inheritWorktreeFields(finishedRun),
  };
  await appendRun(sessionsDir, retryRun);
  wireRunLifecycle(
    sessionsDir,
    sessionId,
    childHandle.child,
    `semantic-retry ${taskId}/${sessionId}`,
  );
  return { sessionId, run: retryRun };
}
