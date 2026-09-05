import { randomUUID } from "node:crypto";
import { existsSync, readdirSync, statSync } from "node:fs";
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

/**
 * Verdict value a judge writes when it could not find a diff to review at all.
 *
 * Absence of evidence is not evidence of drift: without this escape hatch a
 * judge whose `git diff` came back empty (the run was placed in a placeholder
 * repo, the work landed in another checkout) had only `pass`/`drift`/`broken`
 * to choose from and would vote against the change it never saw. This value is
 * deliberately outside the `pass|drift|broken` union, so it counts as "no
 * usable verdict" — the panel goes inconclusive instead of failing the run.
 */
export const INSUFFICIENT_EVIDENCE = "insufficient-evidence";

function isInsufficientEvidence(raw: unknown): boolean {
  return (
    !!raw &&
    typeof raw === "object" &&
    (raw as Record<string, unknown>).verdict === INSUFFICIENT_EVIDENCE
  );
}

function insufficientEvidenceReason(raw: unknown): string {
  const r = (raw as Record<string, unknown> | null)?.reason;
  return typeof r === "string" && r.trim().length > 0
    ? r.trim().slice(0, 400)
    : "(no reason provided)";
}

/**
 * Best `reports/<role>-<repo>.md` for `role`, when the exact `<repo>` half is
 * wrong. A run's registered repo is not always the repo it worked in — a run
 * placed in a placeholder repo writes `coder-t2-claude-bridge.md` while its row
 * says `repo: "ant-design"` — so the repo half of the filename has to be
 * searchable, not just the role half. One match wins outright; several are
 * resolved by exact repo, then newest mtime, then name (so the pick is stable).
 */
function pickReportByRole(
  reportsDir: string,
  role: string,
  repo: string,
): { path: string; matches: string[] } | null {
  let names: string[];
  try {
    names = readdirSync(reportsDir);
  } catch {
    return null;
  }
  const prefix = `${role}-`;
  const matches = names.filter((n) => n.startsWith(prefix) && n.endsWith(".md")).sort();
  if (matches.length === 0) return null;
  if (matches.length === 1) return { path: join(reportsDir, matches[0]), matches };

  const exact = matches.find((n) => n === `${role}-${repo}.md`);
  if (exact) return { path: join(reportsDir, exact), matches };

  let best: { name: string; mtimeMs: number } | null = null;
  for (const name of matches) {
    let mtimeMs: number;
    try {
      mtimeMs = statSync(join(reportsDir, name)).mtimeMs;
    } catch {
      continue;
    }
    const better =
      !best || mtimeMs > best.mtimeMs || (mtimeMs === best.mtimeMs && name < best.name);
    if (better) best = { name, mtimeMs };
  }
  return best ? { path: join(reportsDir, best.name), matches } : null;
}

/**
 * Where the finished run's report is, and how confident the bridge is about it.
 *
 * `found: false` means nothing on disk matched — `path` is then only the name
 * the child was *told* to write, and any prompt built from it has to say so
 * rather than assert it. `candidates` is non-empty only when the repo-direction
 * fallback had to choose between several same-role reports; the judge is shown
 * that list so an mtime tie-break it disagrees with is visible, not silent.
 */
export interface ReportResolution {
  path: string;
  found: boolean;
  candidates: string[];
}

function resolved(
  hit: { path: string; matches: string[] } | null,
): ReportResolution | null {
  if (!hit) return null;
  return {
    path: hit.path,
    found: true,
    candidates: hit.matches.length > 1 ? hit.matches : [],
  };
}

/**
 * Locate the report the finished run was told to write.
 *
 * Two fallbacks, both for the same reason — the `<role>-<repo>.md` name the
 * child was given does not always match the run row the bridge later looks it
 * up by. The repo half drifts when the run ran in a placeholder repo; the role
 * half drifts for retry roles (`coder-svretry2` inheriting `coder`'s report,
 * mirroring `verifier.readChildReport`). Never throws: with nothing on disk it
 * reports the primary path with `found: false`, so the caller still has a name
 * to show while knowing not to trust it.
 */
export function resolveReportForRun(taskId: string, run: Run): ReportResolution {
  const reportsDir = join(SESSIONS_DIR, taskId, "reports");
  const primary = join(reportsDir, `${run.role}-${run.repo}.md`);
  if (existsSync(primary)) return { path: primary, found: true, candidates: [] };

  const byRole = resolved(pickReportByRole(reportsDir, run.role, run.repo));
  if (byRole) return byRole;

  const parsed = parseRole(run.role);
  if (parsed.gate !== null && parsed.baseRole !== run.role) {
    const baseFile = join(reportsDir, `${parsed.baseRole}-${run.repo}.md`);
    if (existsSync(baseFile)) return { path: baseFile, found: true, candidates: [] };
    const byBaseRole = resolved(pickReportByRole(reportsDir, parsed.baseRole, run.repo));
    if (byBaseRole) return byBaseRole;
  }
  return { path: primary, found: false, candidates: [] };
}

/**
 * Absolute path of the finished run's report — {@link resolveReportForRun}
 * without the "did we actually find it" half, for callers that only need a name.
 */
export function reportPathForRun(taskId: string, run: Run): string {
  return resolveReportForRun(taskId, run).path;
}

function posix(p: string): string {
  return p.replace(/\\/g, "/");
}

/**
 * The judge's brief. Both the report path and the repo to diff are spelled out
 * absolutely: a judge is spawned with its cwd set to the finished run's repo,
 * but that repo is not always where the work landed — when the real target repo
 * was reserved, the bridge places a run in a placeholder repo whose tree is
 * clean, and a judge that trusted a bare `git diff HEAD` would review nothing
 * and vote the change down.
 */
export function buildSemanticBrief(args: {
  taskId: string;
  finishedRun: Run;
  repoPath: string;
}): string {
  const resolution = resolveReportForRun(args.taskId, args.finishedRun);
  const reportPath = posix(resolution.path);
  const reportsDir = posix(join(SESSIONS_DIR, args.taskId, "reports"));
  const repo = posix(args.repoPath);

  // Only claim the path is real when the bridge actually found the file. The
  // old brief asserted it unconditionally ("that absolute path, not a
  // cwd-relative guess") even for a name nothing had ever written, which sent
  // the judge chasing a dead path and then voting on the absence.
  const opening = resolution.found
    ? `Re-read the \`## Task\` section above (the user's original request) and the prior agent's report at \`${reportPath}\` — that absolute path, not a cwd-relative guess.`
    : `Re-read the \`## Task\` section above (the user's original request). The prior agent's report SHOULD be at \`${reportPath}\`, but the bridge could not find any report for this run on disk — treat that path as a guess that probably does not open, and expect to have to locate the report yourself.`;

  const ambiguity =
    resolution.candidates.length > 1
      ? [
          `Heads up: no \`${args.finishedRun.role}-${args.finishedRun.repo}.md\` exists, and several same-role reports sit in that directory — ${resolution.candidates.map((n) => `\`${n}\``).join(", ")}. The bridge picked the most recently modified one for you. If it does not describe this run's work, read the others before judging rather than concluding the work is missing.`,
          "",
        ]
      : [];

  return [
    opening,
    "",
    ...ambiguity,
    `If that file does not exist or will not open, do not proceed without a report. Run \`ls "${reportsDir}"\` and look for a file with the same role but a different repo suffix (\`${args.finishedRun.role}-<some-other-repo>.md\`): the repo on the run's row is not always the repo the work landed in, and the report is what tells you where to look for the diff.`,
    "",
    `Then read the diff with \`git -C "${repo}" diff HEAD\` (plus \`git -C "${repo}" status --porcelain\` for untracked files). Cross-check it against the task body's acceptance criteria — does the diff actually accomplish what was asked?`,
    "",
    `If that command shows no changes, the run's registered repo \`${args.finishedRun.repo}\` was probably only a placeholder and the work landed elsewhere. Read the report's \`## Changed files\` and \`## Notes for the coordinator\` for the repo it actually names, and re-run \`git -C <that repo> diff HEAD\` there before judging.`,
    "",
    `If you end up with no diff to review, or with no report at all for this run, do NOT vote \`drift\` or \`broken\` on the missing evidence — write the verdict file with \`"verdict": "${INSUFFICIENT_EVIDENCE}"\` and put every path you searched in \`reason\`. That is an inconclusive panel, not a failed change; voting against a change you never saw is the worse error.`,
    "",
    "Write the verdict file before exiting. The bridge reads it directly to decide whether to gate the commit.",
  ].join("\n");
}

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
  const briefBody = buildSemanticBrief({
    taskId: opts.taskId,
    finishedRun: opts.finishedRun,
    repoPath: opts.appPath,
  });

  if (panelSize === 1) {
    const outcome: AgentGateOutcome = await runAgentGate({
      appPath: opts.appPath,
      taskId: opts.taskId,
      finishedRun: opts.finishedRun,
      taskTitle: opts.taskTitle,
      taskBody: opts.taskBody,
      role: SEMANTIC_VERIFIER_ROLE,
      briefBody,
      verdictFileName: VERDICT_FILE,
    });
    if (outcome.kind === "skipped") {
      return skipped(outcome.reason, outcome.sessionId ?? null);
    }
    if (isInsufficientEvidence(outcome.verdict)) {
      return skipped(
        `judge found no diff to review: ${insufficientEvidenceReason(outcome.verdict)}`,
        outcome.sessionId,
      );
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
    baseBrief: briefBody,
    verdictFilePrefix: "semantic-verdict",
    lenses,
  });

  const votes: PanelVote[] = [];
  let firstSessionId: string | null = null;
  for (const { lens, outcome } of results) {
    if (outcome.kind !== "spawned") continue;
    firstSessionId = firstSessionId ?? outcome.sessionId;
    if (isInsufficientEvidence(outcome.verdict)) {
      // Abstain: not counted as a vote, so the panel can go inconclusive
      // instead of failing a change no judge was able to look at.
      logWarn(
        "semantic-verifier",
        `[${lens}] abstained — no diff to review: ${insufficientEvidenceReason(outcome.verdict)}`,
        { taskId: opts.taskId, sessionId: outcome.sessionId },
      );
      continue;
    }
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
