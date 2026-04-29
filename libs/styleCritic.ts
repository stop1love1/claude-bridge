/**
 * P2b-2 — agent-driven style critic.
 *
 * Spawned in `coordinator.ts:postExitFlow` AFTER the inline claim-vs-
 * diff verifier passes, only when the target app has opted in via
 * `bridge.json.apps[].quality.critic = true`. Judges whether the diff
 * "looks like it belongs" in this codebase based on the auto-detected
 * fingerprint, the symbol index, pinned files, and house-rules.
 *
 *   verdict = match    → commit proceeds
 *   verdict = drift    → commit proceeds, surfaced in meta for review
 *   verdict = alien    → block commit, spawn `<role>-stretry` retry
 *   verdict = skipped  → preconditions not met (no playbook, gate
 *                        crashed, no verdict file) — commit proceeds
 *
 * Distinct from the inline verifier (`libs/verifier.ts`) which checks
 * claim-vs-diff HONESTY without an LLM spawn. The critic is opt-in and
 * costs ~30-100K tokens per task on top of the coder.
 */
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { appendRun, readMeta, type Run, type RunStyleCritic } from "./meta";
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
import { getApp } from "./apps";
import {
  checkEligibility,
  maxAttemptsFor,
  nextRetryRole,
  parseRole,
  renderStrategyPrefix,
} from "./retryLadder";

export const STYLE_CRITIC_ROLE = "style-critic";
export const STYLE_CRITIC_RETRY_SUFFIX = "-stretry";
const VERDICT_FILE = "style-critic-verdict.json";
const ISSUES_CAP = 10;

export interface RunStyleCriticOptions {
  /** Absolute cwd of the target app — the critic spawns here. */
  appPath: string;
  taskId: string;
  /** The coder run we're judging. */
  finishedRun: Run;
  /** Original task header — surfaced into the critic's prompt. */
  taskTitle: string;
  taskBody: string;
}

const BRIEF_BODY = [
  "Run `git diff HEAD` (or `git status --porcelain` + targeted per-file diffs if HEAD is empty) to see what the prior agent shipped, then judge that diff against your playbook above. Surface only the most material deviations — keep `issues` focused on real fit problems, not nits.",
  "",
  "Write the verdict file before exiting. The bridge reads it directly to decide whether to gate the commit.",
].join("\n");

/**
 * Validate + coerce the agent-supplied JSON. Defensive against an LLM
 * that wrote an extra field, missed a required one, or hallucinated a
 * verdict outside the allowed enum. Returns `null` when the payload is
 * unusable; the caller maps that to a `skipped` verdict.
 */
export function parseCriticVerdict(
  raw: unknown,
): { verdict: RunStyleCritic["verdict"]; reason: string; issues: string[] } | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;

  const v = r.verdict;
  if (v !== "match" && v !== "drift" && v !== "alien") return null;

  const reason =
    typeof r.reason === "string" && r.reason.trim().length > 0
      ? r.reason.trim().slice(0, 400)
      : "(no reason provided)";

  const issuesRaw = Array.isArray(r.issues) ? r.issues : [];
  const issues = issuesRaw
    .filter((i): i is string => typeof i === "string" && i.trim().length > 0)
    .map((i) => i.trim().slice(0, 400))
    .slice(0, ISSUES_CAP);

  return { verdict: v, reason, issues };
}

/**
 * Top-level entry: spawn the critic agent against the freshly-finished
 * run, wait for it, parse its verdict, and return the populated
 * `RunStyleCritic` ready for `updateRun`. Always returns a verdict
 * (never `null`) — `skipped` covers every fail-soft path so meta.json
 * has an auditable record either way.
 */
export async function runStyleCritic(
  opts: RunStyleCriticOptions,
): Promise<RunStyleCritic> {
  const start = Date.now();
  const skipped = (
    reason: string,
    sessionId?: string | null,
  ): RunStyleCritic => ({
    verdict: "skipped",
    reason,
    issues: [],
    criticSessionId: sessionId ?? null,
    durationMs: Date.now() - start,
  });

  const outcome: AgentGateOutcome = await runAgentGate({
    appPath: opts.appPath,
    taskId: opts.taskId,
    finishedRun: opts.finishedRun,
    taskTitle: opts.taskTitle,
    taskBody: opts.taskBody,
    role: STYLE_CRITIC_ROLE,
    briefBody: BRIEF_BODY,
    verdictFileName: VERDICT_FILE,
  });

  if (outcome.kind === "skipped") {
    return skipped(outcome.reason, outcome.sessionId ?? null);
  }

  const parsed = parseCriticVerdict(outcome.verdict);
  if (!parsed) {
    return skipped(
      "verdict file did not match `{verdict, reason, issues}` schema",
      outcome.sessionId,
    );
  }

  return {
    verdict: parsed.verdict,
    reason: parsed.reason,
    issues: parsed.issues,
    criticSessionId: outcome.sessionId,
    durationMs: Date.now() - start,
  };
}

/**
 * Render the retry-context block prepended to a `-stretry` prompt.
 * Same heading as the verify-/claim-retry blocks so the model's
 * "what failed last time" contract is uniform.
 */
export function renderStyleRetryContextBlock(critic: RunStyleCritic): string {
  const lines: string[] = [
    "## Auto-retry context — what failed last time",
    "",
    "The previous attempt exited cleanly and the inline verifier passed, but the bridge's style critic flagged the diff as not fitting this codebase. Address the issues below — match the existing conventions / helpers / patterns instead of re-introducing the same drift.",
    "",
    `### Verdict: ${critic.verdict.toUpperCase()}`,
    `**Reason:** ${critic.reason}`,
    "",
  ];
  if (critic.issues.length > 0) {
    lines.push(
      "### Specific issues",
      ...critic.issues.map((i) => `- ${i}`),
      "",
    );
  }
  lines.push(
    "Re-read the `## House style`, `## Available helpers`, and `## Pinned context` sections of this prompt — they are the ground truth the critic judged against. After fixing, write a fresh report at the same path; the bridge will re-run the critic on this attempt and `match`/`drift` gates the auto-commit.",
    "",
  );
  return lines.join("\n");
}

/**
 * Eligibility for style-critic retry. Delegates to the central ladder:
 * counts existing `-stretry*` siblings against `app.retry.style`
 * (default 1).
 */
export function isEligibleForStyleCriticRetry(args: {
  finishedRun: Run;
  meta: { runs: Run[] };
  retry?: import("./apps").AppRetry;
}): boolean {
  return checkEligibility({
    finishedRun: args.finishedRun,
    meta: args.meta,
    gate: "style",
    retry: args.retry,
  }).eligible;
}

/**
 * Spawn the style-retry. Mirrors `verifier.spawnClaimRetry` — direct
 * `spawnFreeSession` so we don't bounce through HTTP, `wireRunLifecycle`
 * for the new run so its lifecycle re-enters `postExitFlow` (which will
 * re-run verify chain → preflight → inline verifier → critic in order).
 */
export async function spawnStyleCriticRetry(args: {
  taskId: string;
  finishedRun: Run;
  critic: RunStyleCritic;
}): Promise<{ sessionId: string; run: Run } | null> {
  const { taskId, finishedRun, critic } = args;
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
    gate: "style",
    retry: app?.retry,
  });
  if (!elig.eligible) return null;
  const parsed = parseRole(finishedRun.role);
  const maxAttempts = maxAttemptsFor(app?.retry, "style");

  const strategyPrefix = renderStrategyPrefix({
    gate: "style",
    attempt: elig.nextAttempt,
    maxAttempts,
  });
  const ctxBlock = renderStyleRetryContextBlock(critic);
  const originalPrompt = readOriginalPrompt(taskId, finishedRun);
  const body =
    originalPrompt.trim() ||
    "(original prompt unavailable — repo state and the failure context above are the only signals you have. Inspect the repo, infer the intent, and try to make forward progress while addressing the style issues.)";
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
    console.error("style-retry spawn failed for", taskId, finishedRun.sessionId, e);
    return null;
  }

  const retryRun: Run = {
    sessionId,
    role: nextRetryRole(parsed.baseRole, "style", elig.nextAttempt),
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
  wireRunLifecycle(
    sessionsDir,
    sessionId,
    childHandle.child,
    `style-retry ${taskId}/${sessionId}`,
  );
  return { sessionId, run: retryRun };
}
