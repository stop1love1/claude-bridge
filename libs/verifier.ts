import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  attributableChanges,
  normPath,
  parsePorcelainV1,
  readDirtyFiles,
  type DiffBaseline,
} from "./diffBaseline";
import { type Run, type RunVerifier } from "./meta";
import { SESSIONS_DIR } from "./paths";
import { parseRole } from "./retryLadder";
import { spawnRetry } from "./retrySpawn";
import { checkEligibility } from "./retryLadder";

const CRETRY_SUFFIX = "-cretry";

// Porcelain parsing lives in the leaf `diffBaseline` module so the dispatch
// path can snapshot a tree without pulling in the retry ladder. Re-exported
// here because it is this module's long-standing public surface.
export { parsePorcelainV1 };

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
  appPath: string;
  taskId: string;
  finishedRun: Run;
}

function isNoneSentinel(line: string): boolean {
  const stripped = line.replace(/^[-*]\s*/, "").replace(/^[_*~]+/, "");
  return stripped.toLowerCase().startsWith("(none");
}

function isPlausiblePath(token: string): boolean {
  if (!token) return false;
  return !token.startsWith("(");
}

const DESCRIPTION_OPENERS = "—–-:;,([{";
const TRAILING_PUNCTUATION = /[:;,]+$/;

function hasPathSignal(token: string): boolean {
  return /[./\\]/.test(token);
}

function stripTrailingPunctuation(token: string): string {
  const stripped = token.replace(TRAILING_PUNCTUATION, "");
  return stripped.length > 0 ? stripped : token;
}

function isSeparatedFromDescription(rawToken: string, rest: string): boolean {
  if (TRAILING_PUNCTUATION.test(rawToken)) return true;
  const trailing = rest.trim();
  if (!trailing) return true;
  return DESCRIPTION_OPENERS.includes(trailing[0]);
}

export function parseChangedFiles(report: string): string[] {
  const idx = report.indexOf("## Changed files");
  if (idx === -1) return [];
  const tail = report.slice(idx + "## Changed files".length);
  const nextHeading = tail.search(/\n##\s/);
  const section = nextHeading === -1 ? tail : tail.slice(0, nextHeading);

  const out: string[] = [];
  for (const rawLine of section.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (isNoneSentinel(line)) return [];
    if (!line.startsWith("-") && !line.startsWith("*")) continue;
    const backtick = line.match(/[-*]\s*`([^`]+)`/);
    if (backtick) {
      const token = backtick[1].trim();
      if (isPlausiblePath(token)) out.push(token);
      continue;
    }
    const bare = line.match(/^[-*]\s*([^\s—–]+)(.*)$/);
    if (bare) {
      const rawToken = bare[1].trim();
      const token = stripTrailingPunctuation(rawToken);
      if (!isPlausiblePath(token)) continue;
      if (!hasPathSignal(token) && !isSeparatedFromDescription(rawToken, bare[2] ?? "")) continue;
      out.push(token);
    }
  }
  return Array.from(new Set(out));
}

function readChildReport(taskId: string, run: Run): string {
  const reportsDir = join(SESSIONS_DIR, taskId, "reports");
  const primary = join(reportsDir, `${run.role}-${run.repo}.md`);
  if (existsSync(primary)) {
    try { return readFileSync(primary, "utf8"); } catch { }
  }
  const parsed = parseRole(run.role);
  if (parsed.gate !== null && parsed.baseRole !== run.role) {
    const baseFile = join(reportsDir, `${parsed.baseRole}-${run.repo}.md`);
    if (existsSync(baseFile)) {
      try { return readFileSync(baseFile, "utf8"); } catch { }
    }
  }
  return "";
}



export function deriveVerdict(args: {
  claimed: string[];
  actual: string[];
  /**
   * The subset of `actual` this run is answerable for — everything that was
   * already dirty when it was dispatched has been removed. Defaults to
   * `actual`, which is the pre-baseline behaviour.
   *
   * Only the "reported no changes" branch and `unclaimedActual` use it. The
   * hallucination and unmatched-claim branches keep comparing against the full
   * tree on purpose: naming a file a predecessor dirtied is over-reporting, not
   * a lie, and failing a run for it would just push agents back to padding
   * their reports with other people's files.
   */
  attributed?: string[];
}): Pick<RunVerifier, "verdict" | "reason" | "unmatchedClaims" | "unclaimedActual"> {
  const claimedNorm = new Set(args.claimed.map(normPath));
  const actualNorm = new Set(args.actual.map(normPath).filter((p) => !isIgnored(p)));
  const mineNorm = new Set(
    (args.attributed ?? args.actual).map(normPath).filter((p) => !isIgnored(p)),
  );

  const unmatchedClaims = [...claimedNorm].filter((p) => !actualNorm.has(p));
  const unclaimedActual = [...mineNorm].filter((p) => !claimedNorm.has(p));

  if (claimedNorm.size > 0 && actualNorm.size === 0) {
    return {
      verdict: "broken",
      reason: `agent claimed ${claimedNorm.size} file change(s) but git diff is empty — likely hallucinated edits`,
      unmatchedClaims,
      unclaimedActual: [],
    };
  }

  if (claimedNorm.size === 0 && mineNorm.size > 0) {
    return {
      verdict: "broken",
      reason: `agent reported "no changes" but git diff shows ${mineNorm.size} touched file(s) — likely silent edits`,
      unmatchedClaims: [],
      unclaimedActual,
    };
  }

  if (unmatchedClaims.length > 0) {
    return {
      verdict: "drift",
      reason: `${unmatchedClaims.length} claimed file(s) not present in git diff`,
      unmatchedClaims,
      unclaimedActual,
    };
  }

  const inherited = actualNorm.size - mineNorm.size;
  return {
    verdict: "pass",
    reason: mineNorm.size === 0
      ? inherited > 0
        ? `analysis-only run — ${inherited} file(s) in the tree predate this run`
        : "analysis-only run — no diff, no claims, nothing to verify"
      : `all ${claimedNorm.size} claimed file(s) match git diff (${unclaimedActual.length} extra unclaimed)`,
    unmatchedClaims: [],
    unclaimedActual,
  };
}

export async function runVerifier(opts: RunVerifierOptions): Promise<RunVerifier> {
  const start = Date.now();

  if (opts.finishedRun.role === "coordinator") {
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
  const actual = await readDirtyFiles(opts.appPath);
  const baseline: DiffBaseline | null = opts.finishedRun.diffBaseline ?? null;
  const attributed = attributableChanges({
    actual,
    baseline,
    appPath: opts.appPath,
  });
  const v = deriveVerdict({ claimed, actual, attributed });
  return {
    ...v,
    claimedFiles: claimed,
    actualFiles: actual,
    durationMs: Date.now() - start,
  };
}

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

export async function spawnClaimRetry(args: {
  taskId: string;
  finishedRun: Run;
  verifier: RunVerifier;
}): Promise<{ sessionId: string; run: Run } | null> {
  return spawnRetry({
    taskId: args.taskId,
    finishedRun: args.finishedRun,
    gate: "claim",
    ctxBlock: renderClaimRetryContextBlock(args.verifier),
    logLabel: "claim-retry",
  });
}

export const CLAIM_RETRY_SUFFIX = CRETRY_SUFFIX;
