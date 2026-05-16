/**
 * LLM-driven commit message generator.
 *
 * Shells out to `claude -p` inside the working tree to read the actual
 * diff and produce a Conventional-Commits-formatted message with body.
 *
 * Why `claude -p` (CLI) over the Anthropic SDK — same reasoning as
 * `libs/detect/llm.ts`: no extra dep, same auth path, works on Windows.
 *
 * Failure modes (timeout, non-zero exit, malformed output, empty diff)
 * all resolve to `null`. Callers (`/api/apps/<name>/commit/suggest` and
 * `/api/tasks/<id>/runs/<sid>/commit/suggest`) fall back to the local
 * heuristic generator on null so the operator's "auto-generate" button
 * still produces SOMETHING even when claude is unavailable.
 *
 * Output format the model MUST follow:
 *
 *   <type>(<scope>): <subject ≤72 chars>
 *
 *   <body line 1 — what + why>
 *   <body line 2 — optional context>
 *   …
 *
 * No code fences, no headings, no trailing chatter.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { treeKill } from "./processKill";

const CLAUDE_BIN = process.env.CLAUDE_BIN ?? "claude";
/**
 * Hard ceiling on how long an interactive "auto-generate" click can
 * block the UI. 45s leaves a generous margin over a typical 10-30s
 * spawn + diff-read pass without making the user think the button hung.
 */
const COMMIT_MSG_TIMEOUT_MS = 45_000;
const STDOUT_CAP_BYTES = 32 * 1024;
const STDERR_CAP_BYTES = 4 * 1024;

/** Subject line cap; commits longer than this get truncated to the cap. */
const SUBJECT_CAP_CHARS = 72;
/** Number of subject-line chars the model is told to aim for. */
const SUBJECT_TARGET_CHARS = 60;

export interface GenerateCommitMessageOptions {
  /** Working tree path — must be a git repo with uncommitted changes. */
  cwd: string;
  /**
   * Optional context line the model can use to ground the subject.
   * Pass the task title for run-scoped commits; leave empty for raw
   * app-scoped invocations.
   */
  taskTitle?: string;
  /**
   * Optional per-invocation timeout override (ms). Falls back to
   * `COMMIT_MSG_TIMEOUT_MS` when omitted.
   */
  timeoutMs?: number;
}

export interface GenerateCommitMessageResult {
  /** Final message ready to drop into the commit composer. */
  message: string;
  /**
   * `llm` when the model produced + parser accepted; `null` when the
   * caller should fall back. Future telemetry can grep this field.
   */
  source: "llm";
}

/**
 * Public entry. Returns `null` on any failure so the caller falls back
 * to the heuristic generator. Never throws.
 */
export async function generateCommitMessageWithLLM(
  opts: GenerateCommitMessageOptions,
): Promise<GenerateCommitMessageResult | null> {
  try {
    if (!existsSync(opts.cwd)) return null;
    const prompt = buildPrompt(opts);
    const raw = await runClaude(prompt, opts.cwd, opts.timeoutMs);
    if (!raw) return null;
    const parsed = parseLLMResponse(raw);
    if (!parsed) return null;
    return { message: parsed, source: "llm" };
  } catch (err) {
    console.warn("[commit-message] generate crashed (non-fatal)", err);
    return null;
  }
}

/**
 * Build the prompt the model gets. Keep it tight — every extra
 * sentence is +tokens on every commit. The model reads the diff
 * itself via the Bash tool (claude -p has Bash enabled by default).
 */
export function buildPrompt(opts: GenerateCommitMessageOptions): string {
  const lines: string[] = [];
  lines.push(
    "Write a single git commit message for the current uncommitted changes in this working tree.",
    "",
    "Steps:",
    "1. Run `git diff HEAD` to see committed-vs-working diffs. If empty, run `git diff --cached` and `git status --porcelain` to find staged + untracked changes.",
    "2. Run `git diff HEAD -- <path>` (or `cat <path>` for untracked files) to inspect the actual content for the most important changes — don't guess from filenames alone.",
    "3. Optionally run `git log -5 --oneline` to match the repo's existing commit style.",
    "",
  );

  if (opts.taskTitle && opts.taskTitle.trim().length > 0) {
    lines.push(
      `Context: this commit closes the task "${opts.taskTitle.trim().slice(0, 200)}".`,
      "Use the task title as ONE input — but ground the subject in what the diff actually shows, not in what the task body said it would do.",
      "",
    );
  }

  lines.push(
    "Output format (REQUIRED — the parser is strict):",
    "",
    "- A single Conventional Commits header line: `<type>(<scope>): <subject>`",
    `  - <type> ∈ feat | fix | refactor | docs | test | chore | perf | style | build | ci`,
    "  - <scope> is the most specific shared directory or module name (omit + the parens if changes span unrelated areas).",
    `  - <subject> ≤ ${SUBJECT_TARGET_CHARS} chars when possible, hard cap ${SUBJECT_CAP_CHARS}. Imperative mood ("add", "fix", "refactor" — not "added" / "adds"). No trailing period.`,
    "- ONE blank line.",
    "- 1-5 lines of body explaining WHAT changed and WHY (the diff already shows the what — bias toward why / context that's not obvious from the lines themselves). Wrap at ~72 chars per line. Bullet points OK if there are several distinct concerns.",
    "",
    "Language: ENGLISH only.",
    "",
    "Hard rules:",
    "- Do NOT include code fences (```), markdown headings (#), or any prose outside the message itself.",
    '- Do NOT add a "Generated by" / "Co-Authored-By" trailer — the bridge appends that on commit.',
    "- Do NOT describe files mechanically (\"updated 5 files\"). Describe behavior.",
    "- If the diff is genuinely empty, output exactly: `chore: no changes`",
    "",
    "Output ONLY the commit message itself. No explanation, no preamble.",
  );

  return lines.join("\n");
}

/**
 * Spawn `claude -p <prompt>` inside `cwd` with the Bash tool enabled
 * so the model can read the diff. Returns the raw stdout (capped) or
 * `null` on any failure (timeout, non-zero exit, spawn error).
 */
function runClaude(
  prompt: string,
  cwd: string,
  timeoutMs: number = COMMIT_MSG_TIMEOUT_MS,
): Promise<string | null> {
  return new Promise<string | null>((resolveRun) => {
    let stdout = "";
    let stderr = "";
    let settled = false;

    const child = spawn(
      CLAUDE_BIN,
      ["-p", "--permission-mode", "bypassPermissions", prompt],
      {
        cwd,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      },
    );

    const settle = (value: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveRun(value);
    };

    const timer = setTimeout(() => {
      treeKill(child, "SIGTERM");
      setTimeout(() => treeKill(child, "SIGKILL"), 3_000);
      console.warn(`[commit-message] timed out after ${timeoutMs}ms`);
      settle(null);
    }, timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
      if (stdout.length > STDOUT_CAP_BYTES) {
        // Keep the tail — claude -p ends its assistant turn at the
        // very end of stdout, and the parser scrubs preamble lines
        // anyway.
        stdout = stdout.slice(-STDOUT_CAP_BYTES);
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
      if (stderr.length > STDERR_CAP_BYTES) {
        stderr = stderr.slice(-STDERR_CAP_BYTES);
      }
    });

    child.on("error", (err) => {
      console.warn(`[commit-message] spawn error:`, err.message);
      settle(null);
    });
    child.on("exit", (code) => {
      if (code !== 0) {
        const tail = stderr.trim().split("\n").slice(-3).join(" | ");
        console.warn(`[commit-message] claude exited ${code}: ${tail}`);
        settle(null);
        return;
      }
      settle(stdout);
    });
  });
}

const VALID_TYPES: ReadonlySet<string> = new Set([
  "feat", "fix", "refactor", "docs", "test", "chore",
  "perf", "style", "build", "ci",
]);

/**
 * Pull the actual commit message out of `claude -p` stdout. The model
 * is told to emit ONLY the message, but defensive against:
 *   - leading / trailing blank lines
 *   - accidental code fences ```` ``` ```` wrapping the whole thing
 *   - leading markdown headings (`# Commit message`)
 *   - trailing `> ` quotes
 *   - the model accidentally adding a Co-Authored-By trailer
 *
 * Returns `null` when the output doesn't even look like a commit
 * message (first non-blank line missing `<type>: ` or `<type>(<scope>): `
 * prefix) so the caller falls back to heuristic.
 */
export function parseLLMResponse(raw: string): string | null {
  if (!raw || raw.trim().length === 0) return null;
  let text = raw;

  // Strip a single outermost code fence if the model wrapped the
  // message in one. Both ``` and ```anything (e.g. ```text) handled.
  const fenceMatch = text.match(/^\s*```[^\n]*\n([\s\S]*?)\n```\s*$/);
  if (fenceMatch) text = fenceMatch[1];

  // Drop leading lines that look like preamble / headings.
  const rawLines = text.split(/\r?\n/);
  let i = 0;
  while (i < rawLines.length) {
    const l = rawLines[i];
    if (l.trim().length === 0) { i++; continue; }
    // Markdown heading? Skip.
    if (/^#+\s/.test(l)) { i++; continue; }
    // "Here's the commit message:" preamble? Skip lines that don't
    // start with a Conventional Commits type, up to a small limit.
    if (i < 4 && !looksLikeHeader(l)) { i++; continue; }
    break;
  }
  if (i >= rawLines.length) return null;

  const headerLine = rawLines[i];
  if (!looksLikeHeader(headerLine)) return null;

  // Subject cap — truncate hard if the model exceeded it.
  let subject = headerLine.trim();
  if (subject.length > SUBJECT_CAP_CHARS) {
    subject = subject.slice(0, SUBJECT_CAP_CHARS - 1) + "…";
  }

  // Body: everything after the header, with leading/trailing blank
  // lines collapsed. Drop any Co-Authored-By trailer the model
  // sneaked in — the bridge adds its own.
  const bodyLines: string[] = [];
  for (let j = i + 1; j < rawLines.length; j++) {
    const l = rawLines[j];
    if (/^\s*Co-Authored-By:/i.test(l)) continue;
    if (/^\s*Generated by Claude/i.test(l)) continue;
    bodyLines.push(l);
  }

  // Trim leading + trailing blanks; collapse multiple blanks in body.
  while (bodyLines.length > 0 && bodyLines[0].trim().length === 0) bodyLines.shift();
  while (bodyLines.length > 0 && bodyLines[bodyLines.length - 1].trim().length === 0) bodyLines.pop();
  const body = collapseBlankRuns(bodyLines).join("\n").trim();

  return body.length > 0 ? `${subject}\n\n${body}` : subject;
}

/** True iff the line looks like `<type>(<scope>): subject` or `<type>: subject`. */
function looksLikeHeader(line: string): boolean {
  const m = /^([a-z]+)(?:\([^)]+\))?:\s+\S/.exec(line.trim());
  return !!m && VALID_TYPES.has(m[1]);
}

/** Collapse runs of 2+ blank lines down to a single blank line. */
function collapseBlankRuns(lines: string[]): string[] {
  const out: string[] = [];
  let lastBlank = false;
  for (const l of lines) {
    const blank = l.trim().length === 0;
    if (blank && lastBlank) continue;
    out.push(l);
    lastBlank = blank;
  }
  return out;
}
