import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type Run } from "./meta";
import { projectDirFor } from "./sessions";
import { spawnRetry } from "./retrySpawn";
import { checkEligibility } from "./retryLadder";
import { isUnderAppRoot } from "./runWorkingTree";

export const DEFAULT_MIN_READS_BEFORE_EDIT = 3;
const READ_TOOLS = new Set(["Read", "Grep", "Glob", "LS"]);
const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

/**
 * Shell commands that only look at files. A Bash call whose first real
 * command is one of these (and that doesn't redirect into a file) counts as
 * a read, the same as the Read tool: agents that survey a repo with
 * `cat`/`grep`/`sed -n` were being scored as "0 Read call(s)" and escalated.
 */
const READ_ONLY_COMMANDS = new Set([
  "cat", "head", "tail", "less", "more", "sed", "awk", "grep", "rg", "egrep", "fgrep",
  "ls", "find", "tree", "wc", "stat", "file", "diff", "type",
]);
const GIT_READ_SUBCOMMANDS = new Set(["show", "diff", "log", "blame", "status", "ls-files", "grep"]);

/** Redirects that write somewhere other than stderr→stdout / the bit bucket. */
function hasFileRedirect(command: string): boolean {
  const stripped = command
    .replace(/2>&1/g, "")
    .replace(/[12]?>\s*\/dev\/null/g, "")
    .replace(/[12]?>\s*NUL\b/gi, "");
  return />/.test(stripped) || /\btee\b/.test(stripped);
}

/** First command word of a shell line, skipping `cd … &&`/`;` and `VAR=x` prefixes. */
function firstCommandWord(command: string): { word: string; rest: string } | null {
  const segments = command.split(/&&|;|\n/).map((s) => s.trim()).filter(Boolean);
  for (const seg of segments) {
    const tokens = seg.split(/\s+/);
    let i = 0;
    while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i])) i++;
    if (i >= tokens.length) continue;
    if (tokens[i] === "cd") continue;
    return { word: tokens[i], rest: tokens.slice(i + 1).join(" ") };
  }
  return null;
}

function bashReadKey(input: unknown): string | null {
  const obj = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
  const command = typeof obj.command === "string" ? obj.command.trim() : "";
  if (!command) return null;
  if (hasFileRedirect(command)) return null;
  const first = firstCommandWord(command);
  if (!first) return null;
  if (first.word === "sed") {
    // `sed -n` prints; `sed -i` rewrites in place.
    if (/(^|\s)-[a-zA-Z]*i/.test(first.rest)) return null;
    if (!/(^|\s)-[a-zA-Z]*n/.test(first.rest)) return null;
  } else if (first.word === "git") {
    const sub = first.rest.split(/\s+/)[0] ?? "";
    if (!GIT_READ_SUBCOMMANDS.has(sub)) return null;
  } else if (!READ_ONLY_COMMANDS.has(first.word)) {
    return null;
  }
  return `bash:${normalizeReadKey(command.replace(/\s+/g, " "))}`;
}

export type PreflightVerdict = "pass" | "skipped" | "fail";

export interface PreflightResult {
  verdict: PreflightVerdict;
  reason: string;
  readsBeforeEdit: number;
  editCount: number;
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
  input?: unknown;
}

const IS_WINDOWS = process.platform === "win32";

function normalizeReadKey(raw: string): string {
  return IS_WINDOWS ? raw.toLowerCase() : raw;
}

function extractFilePath(input: unknown): string | undefined {
  const obj = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
  return typeof obj.file_path === "string" ? obj.file_path : undefined;
}

function readIdentityKey(name: string, input: unknown, fallbackId: string): string {
  const filePath = extractFilePath(input);
  if (filePath) return normalizeReadKey(filePath);
  const obj = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
  if (name === "Grep" || name === "Glob") {
    const pattern = typeof obj.pattern === "string" ? obj.pattern : undefined;
    if (pattern) return normalizeReadKey(pattern);
  }
  return fallbackId;
}

function isOutOfAppRoot(appPath: string | undefined, filePath: string | undefined): boolean {
  if (!appPath || !filePath) return false;
  return !isUnderAppRoot(appPath, filePath);
}

export function countReadsBeforeEdit(
  jsonlText: string,
  appPath?: string,
): {
  readsBeforeEdit: number;
  editCount: number;
  editFilesCount: number;
} {
  let editCount = 0;
  let firstEditSeen = false;
  const readKeys = new Set<string>();
  const editFileKeys = new Set<string>();
  let unidentifiedReadCount = 0;
  let unidentifiedEditCount = 0;

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
        if (isOutOfAppRoot(appPath, extractFilePath(b.input))) continue;
        editCount += 1;
        firstEditSeen = true;
        editFileKeys.add(readIdentityKey(name, b.input, ` edit#${unidentifiedEditCount++}`));
      } else if (READ_TOOLS.has(name) && !firstEditSeen) {
        if (isOutOfAppRoot(appPath, extractFilePath(b.input))) continue;
        readKeys.add(readIdentityKey(name, b.input, ` #${unidentifiedReadCount++}`));
      } else if (name === "Bash" && !firstEditSeen) {
        const key = bashReadKey(b.input);
        if (key) readKeys.add(key);
      }
    }
  }

  return { readsBeforeEdit: readKeys.size, editCount, editFilesCount: editFileKeys.size };
}

export interface RunPreflightOptions {
  finishedRun: Run;
  appPath: string;
  minReadsBeforeEdit?: number;
}

export function runPreflight(opts: RunPreflightOptions): PreflightResult {
  const { finishedRun, appPath } = opts;
  const configuredMin = opts.minReadsBeforeEdit ?? DEFAULT_MIN_READS_BEFORE_EDIT;

  if (finishedRun.role === "coordinator") {
    return {
      verdict: "skipped",
      reason: `role \`${finishedRun.role}\` is exempt from preflight`,
      readsBeforeEdit: 0,
      editCount: 0,
      required: configuredMin,
    };
  }
  // Planners only write plan.md / intake.json / their report under
  // sessions/ — a survey-then-write shape preflight is not built to judge.
  // (That footprint sits inside the app root only when the bridge targets
  // itself, which is exactly when this used to fire.)
  if (/review|audit|inspect|^planner\b/i.test(finishedRun.role)) {
    return {
      verdict: "skipped",
      reason: `read-only role pattern in \`${finishedRun.role}\` — preflight does not apply`,
      readsBeforeEdit: 0,
      editCount: 0,
      required: configuredMin,
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
      required: configuredMin,
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
      required: configuredMin,
    };
  }

  const { readsBeforeEdit, editCount, editFilesCount } = countReadsBeforeEdit(text, appPath);

  if (editCount === 0) {
    return {
      verdict: "pass",
      reason: "analysis-only run (no Edit/Write tool calls) — preflight n/a",
      readsBeforeEdit,
      editCount,
      required: configuredMin,
    };
  }

  const required = Math.max(1, Math.min(configuredMin, editFilesCount));

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
