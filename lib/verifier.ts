/**
 * P2b-1 — inline claim-vs-diff verifier.
 *
 * Runs synchronously after the verify chain passes (or when no chain
 * was configured). Cheap, deterministic, no LLM spawn — catches the
 * highest-frequency failure mode (agent claims it changed files it
 * didn't actually touch, or vice-versa) before the bridge auto-commits.
 *
 *   verdict = pass    → commit proceeds
 *   verdict = drift   → block commit, spawn `<role>-cretry` with the
 *                       claim/diff mismatch injected at top of prompt
 *   verdict = broken  → same retry path as drift; reserved for the
 *                       most extreme mismatch (claims with no diff)
 *   verdict = skipped → preconditions not met (no report file, role is
 *                       a retry, etc.) — commit proceeds untouched
 *
 * Agent-driven verifier (LLM judging summary + diff) is roadmap P2b-2,
 * deferred until P3 (style fingerprint) lands so the LLM has real
 * context to judge against. The inline version locks in HONESTY today
 * — "did the agent claim what it actually shipped?" — without paying a
 * spawn-tax per task.
 */
import { existsSync, readFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { promisify } from "node:util";
import { appendRun, readMeta, type Run, type RunVerifier } from "./meta";
import { wireRunLifecycle } from "./coordinator";
import { resolveRepoCwd } from "./repos";
import { spawnFreeSession } from "./spawn";
import { freeSessionSettingsPath, writeSessionSettings } from "./permissionSettings";
import { readOriginalPrompt } from "./promptStore";
import { isAlreadyRetryRun } from "./verifyChain";
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

const execFileP = promisify(execFile);
const CRETRY_SUFFIX = "-cretry";
const GIT_TIMEOUT_MS = 5000;

/** Files the verifier ignores when comparing claims vs diff. Lockfiles
 * are commonly touched as a side effect of unrelated work; lock churn
 * shouldn't trigger a "you didn't claim this" verdict. */
const IGNORED_FILE_PATTERNS = [
  /(^|\/)package-lock\.json$/,
  /(^|\/)yarn\.lock$/,
  /(^|\/)pnpm-lock\.yaml$/,
  /(^|\/)bun\.lock$/,
  /(^|\/)bun\.lockb$/,
  /(^|\/)Cargo\.lock$/,
  /(^|\/)poetry\.lock$/,
  /(^|\/)Pipfile\.lock$/,
];

function isIgnored(path: string): boolean {
  const norm = path.replace(/\\/g, "/");
  return IGNORED_FILE_PATTERNS.some((re) => re.test(norm));
}

export interface RunVerifierOptions {
  /** Absolute cwd of the target app (where `git diff` runs). */
  appPath: string;
  /** Task id — used to locate the child's report file under sessions/. */
  taskId: string;
  /** The just-finished run we're verifying. */
  finishedRun: Run;
}

/**
 * Parse the `## Changed files` section of a child report. Each bullet
 * is expected to look like `` - `path/to/file` — description ``. We
 * accept either backtick-wrapped or bare paths and ignore the
 * description text. The literal placeholder `(none — analysis only)`
 * (per `lib/childPrompt.ts` report template) maps to an empty list.
 */
export function parseChangedFiles(report: string): string[] {
  const idx = report.indexOf("## Changed files");
  if (idx === -1) return [];
  // Slice to the next H2 heading (or end of file).
  const tail = report.slice(idx + "## Changed files".length);
  const nextHeading = tail.search(/\n##\s/);
  const section = nextHeading === -1 ? tail : tail.slice(0, nextHeading);

  const out: string[] = [];
  for (const rawLine of section.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith("(none")) return []; // analysis-only contract
    if (!line.startsWith("-") && !line.startsWith("*")) continue;
    // Try backtick-wrapped path first, fall back to first whitespace-
    // separated token.
    const backtick = line.match(/[-*]\s*`([^`]+)`/);
    if (backtick) {
      out.push(backtick[1].trim());
      continue;
    }
    const bare = line.match(/[-*]\s*([^\s—–-]+)/);
    if (bare) out.push(bare[1].trim());
  }
  // De-dup + drop empties.
  return Array.from(new Set(out.filter(Boolean)));
}

/**
 * Locate the child's report at the canonical path written by the
 * `## Report contract` section of `buildChildPrompt`. Returns "" when
 * the file is missing — which itself becomes a `skipped` verdict
 * upstream (no claims to compare against).
 */
function readChildReport(taskId: string, run: Run): string {
  const path = join(
    SESSIONS_DIR,
    taskId,
    "reports",
    `${run.role}-${run.repo}.md`,
  );
  if (!existsSync(path)) return "";
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

/**
 * Run `git diff --name-only HEAD` in the app cwd to enumerate paths the
 * child actually touched (relative to the app's working tree). Falls
 * back to `git status --porcelain` when HEAD diff returns empty — for
 * runs whose changes haven't been committed yet (the common case
 * because P2 runs the verifier BEFORE auto-commit).
 *
 * Fail-soft to []: a non-git tree, missing binary, or timeout produces
 * an empty list, which the verifier upstream interprets as "nothing to
 * compare" (skipped verdict).
 */
async function readActualFiles(appPath: string): Promise<string[]> {
  const collected = new Set<string>();
  try {
    const { stdout } = await execFileP("git", ["status", "--porcelain=v1"], {
      cwd: appPath,
      timeout: GIT_TIMEOUT_MS,
      windowsHide: true,
      maxBuffer: 256 * 1024,
    });
    for (const rawLine of stdout.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line) continue;
      // Porcelain v1 lines: "XY <path>" or "XY <orig> -> <new>" for renames.
      // We strip the 2-char status prefix + leading space, then take the
      // post-`->` half for renames so we record the destination path.
      const stripped = line.replace(/^.{2}\s+/, "");
      const renameSplit = stripped.split(" -> ");
      const path = (renameSplit[1] ?? renameSplit[0]).trim();
      if (path) collected.add(path);
    }
  } catch {
    // Non-git or git unavailable — return whatever we collected (likely empty).
  }
  return [...collected];
}

/**
 * Compare claimed file list against actual diff and emit a verdict.
 * The thresholds below are deliberately permissive: the goal is to
 * catch outright hallucinations / silent edits, not to nag about minor
 * reporting laxity.
 */
export function deriveVerdict(args: {
  claimed: string[];
  actual: string[];
}): Pick<RunVerifier, "verdict" | "reason" | "unmatchedClaims" | "unclaimedActual"> {
  const claimedNorm = new Set(args.claimed.map(normPath));
  const actualNorm = new Set(args.actual.map(normPath).filter((p) => !isIgnored(p)));

  const unmatchedClaims = [...claimedNorm].filter((p) => !actualNorm.has(p));
  const unclaimedActual = [...actualNorm].filter((p) => !claimedNorm.has(p));

  // BROKEN: agent claimed concrete file changes but the diff is empty.
  // This is the strongest hallucination signal — the agent said "I
  // edited X.ts" but the working tree shows no edits at all.
  if (claimedNorm.size > 0 && actualNorm.size === 0) {
    return {
      verdict: "broken",
      reason: `agent claimed ${claimedNorm.size} file change(s) but git diff is empty — likely hallucinated edits`,
      unmatchedClaims,
      unclaimedActual: [],
    };
  }

  // BROKEN: agent ran read-only / analysis-only (empty claims) but the
  // diff shows non-trivial actual changes. Either the agent edited
  // without telling us (sloppy reporting) OR a hook auto-modified
  // files and we should flag for human review.
  if (claimedNorm.size === 0 && actualNorm.size > 0) {
    return {
      verdict: "broken",
      reason: `agent reported "no changes" but git diff shows ${actualNorm.size} touched file(s) — likely silent edits`,
      unmatchedClaims: [],
      unclaimedActual,
    };
  }

  // DRIFT: any unmatched claims (claimed but not in diff) is the most
  // common honest mistake mode — agent thought it changed file X but
  // actually edited Y.
  if (unmatchedClaims.length > 0) {
    return {
      verdict: "drift",
      reason: `${unmatchedClaims.length} claimed file(s) not present in git diff`,
      unmatchedClaims,
      unclaimedActual,
    };
  }

  // PASS: all claims found in diff. Unclaimed-actual is informational
  // only (agents legitimately edit support files without itemizing
  // each one); we surface the list but don't fail on it.
  return {
    verdict: "pass",
    reason: actualNorm.size === 0
      ? "analysis-only run — no diff, no claims, nothing to verify"
      : `all ${claimedNorm.size} claimed file(s) match git diff (${unclaimedActual.length} extra unclaimed)`,
    unmatchedClaims: [],
    unclaimedActual,
  };
}

function normPath(p: string): string {
  return p.replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "");
}

/**
 * Top-level entry: read the child's report, run git diff, compute the
 * verdict, return the populated `RunVerifier` ready for `updateRun`.
 *
 * Returns a `skipped` verdict (not null) when preconditions aren't met
 * — keeping a marker in meta.json makes "we considered this but
 * skipped" auditable later.
 */
export async function runVerifier(opts: RunVerifierOptions): Promise<RunVerifier> {
  const start = Date.now();

  // Skip retries / coordinator runs entirely — verifying a -vretry
  // would re-fire the whole loop, and the coordinator never produces a
  // child report at the same path.
  if (isAlreadyRetryRun(opts.finishedRun.role) || opts.finishedRun.role === "coordinator") {
    return {
      verdict: "skipped",
      reason: `role \`${opts.finishedRun.role}\` is exempt from claim-vs-diff verification`,
      claimedFiles: [],
      actualFiles: [],
      unmatchedClaims: [],
      unclaimedActual: [],
      durationMs: Date.now() - start,
    };
  }

  const report = readChildReport(opts.taskId, opts.finishedRun);
  if (!report) {
    return {
      verdict: "skipped",
      reason: "no report file at sessions/<task>/reports/<role>-<repo>.md",
      claimedFiles: [],
      actualFiles: [],
      unmatchedClaims: [],
      unclaimedActual: [],
      durationMs: Date.now() - start,
    };
  }

  const claimed = parseChangedFiles(report);
  const actual = await readActualFiles(opts.appPath);
  const v = deriveVerdict({ claimed, actual });
  return {
    ...v,
    claimedFiles: claimed,
    actualFiles: actual,
    durationMs: Date.now() - start,
  };
}

/**
 * Render the retry-context block prepended to a `-cretry` prompt.
 * Same `## Auto-retry context — what failed last time` heading as the
 * other two retry paths so the agent has consistent contract.
 */
export function renderClaimRetryContextBlock(verifier: RunVerifier): string {
  const lines: string[] = [
    "## Auto-retry context — what failed last time",
    "",
    "The previous attempt exited cleanly and the verify chain passed, but the bridge's claim-vs-diff check rejected the report. The report you wrote did not match the actual git diff in the working tree — fix the mismatch and re-attempt.",
    "",
    `### Verdict: ${verifier.verdict.toUpperCase()}`,
    `**Reason:** ${verifier.reason}`,
    "",
  ];

  if (verifier.unmatchedClaims.length > 0) {
    lines.push(
      "### Files you CLAIMED to change but the diff doesn't show",
      ...verifier.unmatchedClaims.map((p) => `- \`${p}\``),
      "",
      "Either you didn't actually edit these (correct your report) OR you edited them and the changes were lost (re-apply them).",
      "",
    );
  }
  if (verifier.unclaimedActual.length > 0) {
    lines.push(
      "### Files in the diff but NOT in your `## Changed files` list",
      ...verifier.unclaimedActual.map((p) => `- \`${p}\``),
      "",
      "Either add these to your `## Changed files` section (with a one-line description of why they were touched) OR revert them if they were unintended.",
      "",
    );
  }

  lines.push(
    "Make the report match reality. After fixing, write a fresh report at the same path. The bridge will re-run claim-vs-diff verification on this attempt — passing it gates the auto-commit.",
    "",
  );
  return lines.join("\n");
}

/**
 * Eligibility for claim-vs-diff retry. Delegates to the central ladder
 * — counts existing `-cretry*` siblings against `app.retry.claim`
 * (default 1). Note: preflight retries also live under `-cretry`, and
 * the ladder shares the slot between claim + preflight.
 */
export function isEligibleForClaimRetry(args: {
  finishedRun: Run;
  meta: { runs: Run[] };
  retry?: import("./apps").AppRetry;
}): boolean {
  return checkEligibility({
    finishedRun: args.finishedRun,
    meta: args.meta,
    gate: "claim",
    retry: args.retry,
  }).eligible;
}

/**
 * Spawn the claim-retry. Mirrors `verifyChain.spawnVerifyRetry` (which
 * itself mirrors `childRetry.spawnRetryRun`) — direct `spawnFreeSession`
 * so we don't bounce through HTTP.
 *
 * Async: `appendRun` is gated by the per-task lock added in cluster B
 * (`meta.withTaskLock`), so we MUST await it before wiring the
 * lifecycle. Otherwise an early `exit` from the freshly-spawned child
 * could fire `updateRun` against a sessionId not yet visible in
 * meta.json, throwing "run X not found" inside the lock.
 */
export async function spawnClaimRetry(args: {
  taskId: string;
  finishedRun: Run;
  verifier: RunVerifier;
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
    gate: "claim",
    retry: app?.retry,
  });
  if (!elig.eligible) return null;
  const parsed = parseRole(finishedRun.role);
  const maxAttempts = maxAttemptsFor(app?.retry, "claim");

  const strategyPrefix = renderStrategyPrefix({
    gate: "claim",
    attempt: elig.nextAttempt,
    maxAttempts,
  });
  const ctxBlock = renderClaimRetryContextBlock(verifier);
  const originalPrompt = readOriginalPrompt(taskId, finishedRun);
  const body =
    originalPrompt.trim() ||
    "(original prompt unavailable — repo state and the failure context above are the only signals you have. Re-read the report at sessions/<task>/reports/<role>-<repo>.md, fix the discrepancy, and re-attempt.)";
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
    console.error("claim-retry spawn failed for", taskId, finishedRun.sessionId, e);
    return null;
  }

  const retryRun: Run = {
    sessionId,
    role: nextRetryRole(parsed.baseRole, "claim", elig.nextAttempt),
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
    `claim-retry ${taskId}/${sessionId}`,
  );
  return { sessionId, run: retryRun };
}

export const CLAIM_RETRY_SUFFIX = CRETRY_SUFFIX;
