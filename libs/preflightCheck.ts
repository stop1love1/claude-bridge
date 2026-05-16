/**
 * P3b / B1 — preflight check: did the agent actually read enough of
 * the codebase before editing?
 *
 * Reads the child's `<sessionId>.jsonl` transcript and counts Read
 * tool calls that occur BEFORE the first Edit/Write/MultiEdit/
 * NotebookEdit call. If the count is below `MIN_READS_BEFORE_EDIT`
 * (default 3) and the agent did make code changes, we mark the run
 * as preflight-failed and the caller spawns a `-cretry` follow-up.
 *
 * Skipped for:
 *   - read-only roles (`reviewer`, anything with "review" in the role)
 *   - retries (`-retry`, `-vretry`, `-cretry` already)
 *   - runs that produced no Edit/Write at all (analysis-only is fine)
 *
 * Pure heuristic — no LLM call. Catches the common "agent jumped
 * straight to writing code without reading the existing patterns"
 * mode that produces alien-looking output.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type Run } from "./meta";
import { projectDirFor } from "./sessions";
import { spawnRetry } from "./retrySpawn";
import { checkEligibility } from "./retryLadder";

/** Default required Read count before any Edit/Write. Overridable per
 * app via `App.preflightReads`. */
export const DEFAULT_MIN_READS_BEFORE_EDIT = 3;
/** Tools the agent can call without "counting" — these don't change
 * code so they bypass the gate entirely. */
const READ_TOOLS = new Set(["Read", "Grep", "Glob", "LS"]);
const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

export type PreflightVerdict = "pass" | "skipped" | "fail";

export interface PreflightResult {
  verdict: PreflightVerdict;
  reason: string;
  /** Read tool calls observed before the first Edit/Write. */
  readsBeforeEdit: number;
  /** Total Edit/Write calls in the session (0 = analysis-only). */
  editCount: number;
  /** Required minimum (the threshold we compared against). */
  required: number;
  retryScheduled?: boolean;
}

interface JsonlEntry {
  type?: string;
  message?: { content?: unknown };
}

interface ToolUseBlock {
  type?: string;
  name?: string;
}

/**
 * Walk the transcript forward, counting tool_use events by name.
 * Returns the count of read-tool calls observed before the FIRST
 * edit-tool call, plus the total edit-tool count for the whole
 * session (so we can distinguish "analysis only" from "edited but
 * skipped reads").
 */
export function countReadsBeforeEdit(jsonlText: string): {
  readsBeforeEdit: number;
  editCount: number;
} {
  let readsBeforeEdit = 0;
  let editCount = 0;
  let firstEditSeen = false;

  for (const line of jsonlText.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let obj: JsonlEntry;
    try {
      obj = JSON.parse(trimmed) as JsonlEntry;
    } catch {
      continue;
    }
    if (obj.type !== "assistant") continue;
    const content = obj.message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (!block || typeof block !== "object") continue;
      const b = block as ToolUseBlock;
      if (b.type !== "tool_use" || typeof b.name !== "string") continue;
      const name = b.name;
      if (EDIT_TOOLS.has(name)) {
        editCount += 1;
        if (!firstEditSeen) firstEditSeen = true;
      } else if (READ_TOOLS.has(name) && !firstEditSeen) {
        readsBeforeEdit += 1;
      }
    }
  }

  return { readsBeforeEdit, editCount };
}

export interface RunPreflightOptions {
  finishedRun: Run;
  /** Absolute cwd of the target app — used to locate the .jsonl. */
  appPath: string;
  /** Override the default minimum read count (per-app via
   *  `App.preflightReads`). */
  minReadsBeforeEdit?: number;
}

/**
 * Top-level entry. Locates the child's `.jsonl`, parses tool calls,
 * and emits a verdict. `skipped` covers all preconditions that
 * disqualify a run from preflight check (retries, read-only roles,
 * missing transcript). Never throws.
 */
export function runPreflight(opts: RunPreflightOptions): PreflightResult {
  const { finishedRun, appPath } = opts;
  const required = opts.minReadsBeforeEdit ?? DEFAULT_MIN_READS_BEFORE_EDIT;

  // Coordinator never edits source — skip. Retry runs are no longer
  // skipped here; checking the agent re-read what it needed on the fix
  // is exactly what preflight is for. Runaway loop prevention lives in
  // `checkEligibility` inside `spawnPreflightRetry`.
  if (finishedRun.role === "coordinator") {
    return {
      verdict: "skipped",
      reason: `role \`${finishedRun.role}\` is exempt from preflight`,
      readsBeforeEdit: 0,
      editCount: 0,
      required,
    };
  }
  // Read-only role names — case-insensitive match on common verbs.
  if (/review|audit|inspect/i.test(finishedRun.role)) {
    return {
      verdict: "skipped",
      reason: `read-only role pattern in \`${finishedRun.role}\` — preflight does not apply`,
      readsBeforeEdit: 0,
      editCount: 0,
      required,
    };
  }

  const projectDir = projectDirFor(appPath);
  const jsonlPath = join(projectDir, `${finishedRun.sessionId}.jsonl`);
  if (!existsSync(jsonlPath)) {
    return {
      verdict: "skipped",
      reason: "transcript .jsonl missing — cannot inspect tool sequence",
      readsBeforeEdit: 0,
      editCount: 0,
      required,
    };
  }

  let text = "";
  try {
    text = readFileSync(jsonlPath, "utf8");
  } catch {
    return {
      verdict: "skipped",
      reason: "transcript .jsonl unreadable",
      readsBeforeEdit: 0,
      editCount: 0,
      required,
    };
  }

  const { readsBeforeEdit, editCount } = countReadsBeforeEdit(text);

  // Analysis-only runs (no Edit/Write at all) trivially pass — there
  // was no code to read context for.
  if (editCount === 0) {
    return {
      verdict: "pass",
      reason: "analysis-only run (no Edit/Write tool calls) — preflight n/a",
      readsBeforeEdit,
      editCount,
      required,
    };
  }

  if (readsBeforeEdit < required) {
    return {
      verdict: "fail",
      reason: `agent made ${readsBeforeEdit} Read call(s) before the first Edit/Write — minimum is ${required}`,
      readsBeforeEdit,
      editCount,
      required,
    };
  }

  return {
    verdict: "pass",
    reason: `${readsBeforeEdit} Read call(s) before first Edit/Write (≥ ${required})`,
    readsBeforeEdit,
    editCount,
    required,
  };
}

/**
 * Render the retry-context block prepended to a `-cretry` prompt
 * spawned because of a preflight failure. Same `## Auto-retry context`
 * heading as the other retry paths so the agent sees a consistent
 * contract regardless of why we re-ran.
 */
export function renderPreflightRetryContextBlock(
  preflight: PreflightResult,
): string {
  return [
    "## Auto-retry context — what failed last time",
    "",
    "The previous attempt edited code without first reading enough of the existing codebase to understand its conventions. This is the single biggest cause of code that reads as alien — the agent reaches for what it knows from training data instead of what the team actually does.",
    "",
    `### Verdict: PREFLIGHT FAIL`,
    `**Reason:** ${preflight.reason}`,
    `- Read calls before first Edit/Write: **${preflight.readsBeforeEdit}** (required: **${preflight.required}**)`,
    `- Edit/Write calls total: ${preflight.editCount}`,
    "",
    "### Required process",
    "Before any Edit/Write/MultiEdit:",
    `1. **Grep / Read at least ${preflight.required} relevant files** that already do similar work in this repo. Look at what conventions exist (early returns? error shapes? naming? where similar features live?).`,
    "2. Match those conventions in your changes.",
    "3. After editing, your report's `## Changed files` section MUST list each touched file (the bridge claim-vs-diff verifier checks this).",
    "",
    "Re-run the task with this process. The bridge will re-check preflight on this attempt.",
    "",
  ].join("\n");
}

/**
 * Eligibility for a preflight-driven retry. Delegates to the central
 * ladder against gate=`preflight`, which shares the `-cretry` suffix /
 * budget slot with claim-vs-diff retries (legacy behavior — both
 * gates signal "agent didn't follow process").
 */
export function isEligibleForPreflightRetry(args: {
  finishedRun: Run;
  meta: { runs: Run[] };
  retry?: import("./apps").AppRetry;
}): boolean {
  return checkEligibility({
    finishedRun: args.finishedRun,
    meta: args.meta,
    gate: "preflight",
    retry: args.retry,
  }).eligible;
}

/**
 * Spawn a preflight-fail retry. Same shape as crash/verify/claim/style
 * retries — see `libs/retrySpawn.ts`. The preflight gate routes through
 * the `-cretry` budget slot; the rendered context block lists what the
 * preflight checker found wrong.
 */
export async function spawnPreflightRetry(args: {
  taskId: string;
  finishedRun: Run;
  preflight: PreflightResult;
}): Promise<{ sessionId: string; run: Run } | null> {
  return spawnRetry({
    taskId: args.taskId,
    finishedRun: args.finishedRun,
    gate: "preflight",
    ctxBlock: renderPreflightRetryContextBlock(args.preflight),
    logLabel: "preflight-retry",
  });
}
