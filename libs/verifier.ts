import { existsSync, readFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import { type Run, type RunVerifier } from "./meta";
import { SESSIONS_DIR } from "./paths";
import { parseRole } from "./retryLadder";
import { spawnRetry } from "./retrySpawn";
import { checkEligibility } from "./retryLadder";

const execFileP = promisify(execFile);
const CRETRY_SUFFIX = "-cretry";
const GIT_TIMEOUT_MS = 5000;

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

const PORCELAIN_PREFIX_LEN = 3;
const PORCELAIN_STATUS_CODES = " MTADRCU?!";
const RENAME_ARROW = " -> ";

const C_ESCAPE_BYTES: Record<string, number> = {
  a: 0x07,
  b: 0x08,
  f: 0x0c,
  n: 0x0a,
  r: 0x0d,
  t: 0x09,
  v: 0x0b,
  '"': 0x22,
  "\\": 0x5c,
};

function unquotePorcelainPath(token: string): string {
  if (token.length < 2) return token;
  if (!token.startsWith('"') || !token.endsWith('"')) return token;

  const chars = Array.from(token.slice(1, -1));
  const encoder = new TextEncoder();
  const bytes: number[] = [];
  let i = 0;

  while (i < chars.length) {
    const ch = chars[i];
    if (ch !== "\\") {
      for (const byte of encoder.encode(ch)) bytes.push(byte);
      i += 1;
      continue;
    }
    const next = chars[i + 1];
    if (next === undefined) {
      bytes.push(C_ESCAPE_BYTES["\\"]);
      i += 1;
      continue;
    }
    const simple = C_ESCAPE_BYTES[next];
    if (simple !== undefined) {
      bytes.push(simple);
      i += 2;
      continue;
    }
    const octal = chars.slice(i + 1, i + 1 + 3).join("");
    if (/^[0-7]{3}$/.test(octal)) {
      bytes.push(parseInt(octal, 8));
      i += 4;
      continue;
    }
    for (const byte of encoder.encode(next)) bytes.push(byte);
    i += 2;
  }

  return new TextDecoder().decode(new Uint8Array(bytes));
}

function parsePorcelainLine(rawLine: string): string | null {
  const line = rawLine.replace(/\r+$/, "");
  if (line.length <= PORCELAIN_PREFIX_LEN) return null;
  if (line[PORCELAIN_PREFIX_LEN - 1] !== " ") return null;

  const x = line[0];
  const y = line[1];
  if (!PORCELAIN_STATUS_CODES.includes(x)) return null;
  if (!PORCELAIN_STATUS_CODES.includes(y)) return null;
  if (x === " " && y === " ") return null;

  const rest = line.slice(PORCELAIN_PREFIX_LEN);
  const isRename = x === "R" || x === "C" || y === "R" || y === "C";
  let token = rest;
  if (isRename) {
    const parts = rest.split(RENAME_ARROW);
    token = parts[1] ?? parts[0];
  }

  const path = unquotePorcelainPath(token);
  return path.length > 0 ? path : null;
}

export function parsePorcelainV1(stdout: string): string[] {
  const collected = new Set<string>();
  for (const rawLine of stdout.split(/\r?\n/)) {
    const path = parsePorcelainLine(rawLine);
    if (path !== null) collected.add(path);
  }
  return [...collected];
}

async function readActualFiles(appPath: string): Promise<string[]> {
  try {
    const { stdout } = await execFileP("git", ["status", "--porcelain=v1"], {
      cwd: appPath,
      timeout: GIT_TIMEOUT_MS,
      windowsHide: true,
      maxBuffer: 256 * 1024,
    });
    return parsePorcelainV1(stdout);
  } catch {
    return [];
  }
}

export function deriveVerdict(args: {
  claimed: string[];
  actual: string[];
}): Pick<RunVerifier, "verdict" | "reason" | "unmatchedClaims" | "unclaimedActual"> {
  const claimedNorm = new Set(args.claimed.map(normPath));
  const actualNorm = new Set(args.actual.map(normPath).filter((p) => !isIgnored(p)));

  const unmatchedClaims = [...claimedNorm].filter((p) => !actualNorm.has(p));
  const unclaimedActual = [...actualNorm].filter((p) => !claimedNorm.has(p));

  if (claimedNorm.size > 0 && actualNorm.size === 0) {
    return {
      verdict: "broken",
      reason: `agent claimed ${claimedNorm.size} file change(s) but git diff is empty — likely hallucinated edits`,
      unmatchedClaims,
      unclaimedActual: [],
    };
  }

  if (claimedNorm.size === 0 && actualNorm.size > 0) {
    return {
      verdict: "broken",
      reason: `agent reported "no changes" but git diff shows ${actualNorm.size} touched file(s) — likely silent edits`,
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
  const actual = await readActualFiles(opts.appPath);
  const v = deriveVerdict({ claimed, actual });
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
