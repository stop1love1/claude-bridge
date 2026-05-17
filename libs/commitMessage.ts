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
 * Build the prompt the model gets. Tuned for **semantic** commits —
 * the recurring failure mode in this repo was the model emitting
 * file-list-shaped messages like `chore: update 5 files` or
 * paraphrasing the task title without ever reading the implementation.
 * The instructions push hard in three directions:
 *
 *   1. Read the actual code that changed (not just the filenames),
 *      so the subject reflects the BEHAVIOR delta, not the noun list.
 *   2. Pick `<type>` from what the change DOES at runtime, not from
 *      surface heuristics like "I see new files therefore feat".
 *   3. Body explains WHY + observable effect — what users / callers
 *      experience differently — instead of restating the diff.
 *
 * Few-shot examples anchor "good" vs "bad" so the model has a target
 * shape, not just rules. Keep the prompt long enough to hit the
 * semantic bar but short enough that it doesn't bloat per-commit
 * latency / cost — the model reads the diff itself via Bash; we
 * shouldn't pre-quote it here.
 */
export function buildPrompt(opts: GenerateCommitMessageOptions): string {
  const lines: string[] = [];
  lines.push(
    "Write ONE git commit message for the current uncommitted changes in this working tree.",
    "",
    "Your job: describe the SEMANTIC change — what behavior, contract, or invariant shifted — not the file mechanics. A commit message that reads like `git status --short` is a failure.",
    "",
    "Investigation steps (do all that apply):",
    "1. `git diff HEAD` to see committed-vs-working diffs. If empty, `git diff --cached` then `git status --porcelain` for staged + untracked.",
    "2. For each meaningfully changed file, run `git diff HEAD -- <path>` (or `cat <path>` for untracked) and READ the actual hunks. Filenames + line counts are not enough — the message must reflect what the code now does differently.",
    "3. `git log -8 --oneline` to match the repo's existing commit style (scope vocabulary, subject phrasing).",
    "4. If multiple files changed for the SAME reason, treat it as one semantic change. If they changed for unrelated reasons, the subject should name the dominant one and the body lists the rest as sub-bullets.",
    "",
  );

  if (opts.taskTitle && opts.taskTitle.trim().length > 0) {
    lines.push(
      `Context: this commit is part of the task "${opts.taskTitle.trim().slice(0, 200)}".`,
      "The task title is ONE input, never the whole truth — ground the subject in what the diff actually shows. If the diff diverged from the task title (scope grew / shrank / pivoted), describe the diff, not the title.",
      "",
    );
  }

  lines.push(
    "Output format (REQUIRED — Conventional Commits, parser is strict):",
    "",
    "Header line: `<type>(<scope>): <subject>`",
    `- <type> ∈ feat | fix | refactor | docs | test | chore | perf | style | build | ci`,
    "  - feat = user-visible NEW capability or API surface added",
    "  - fix = corrects a bug — code now produces the right output where it didn't before",
    "  - refactor = same external behavior, internal restructure",
    "  - perf = same behavior, measurably faster / lighter",
    "  - test / docs / chore / build / ci / style = obvious from name. Pick chore only when nothing else fits.",
    "  - WRONG type is the most common failure: adding a file does NOT make it `feat`. If the new file is internal plumbing for an existing feature, that's `refactor`. If the change makes wrong behavior right, that's `fix` even if lines were added.",
    "- <scope> = the most specific shared module / feature / package the diff touches (e.g. `finance`, `auth`, `coordinator-nudge`). Skip generic top-levels like `src`, `app`, `lib`. Omit `(<scope>)` entirely when changes span unrelated areas.",
    `- <subject>: imperative mood ("add", "fix", "remove" — NOT "added" / "adds" / "adding"), ≤ ${SUBJECT_TARGET_CHARS} chars when possible (hard cap ${SUBJECT_CAP_CHARS}). No trailing period. No vague verbs ("update", "change", "improve") unless paired with a specific noun ("update auth retry budget", not "update auth").`,
    "",
    "Blank line.",
    "",
    "Body: 1–6 lines explaining WHY + the observable effect.",
    "- Lead with the why: what was wrong / missing / suboptimal before this change.",
    "- Then the effect: what callers / users / the system now experience.",
    "- Skip what the diff already shows (which lines moved, which files touched).",
    "- Bullets are fine when there are 2–4 distinct concerns; prose is fine for a single concern. Wrap at ~72 chars per line.",
    "- Skip the body entirely for genuinely trivial changes (typo fix, one-line config tweak) — header alone is acceptable.",
    "",
    "Language: ENGLISH only.",
    "",
    "Examples of GOOD vs BAD:",
    "",
    "BAD:  `chore: update 5 files`",
    "GOOD: `fix(payments): acquire fund lock before opening transaction`",
    "",
    "BAD:  `feat: add new things`",
    "GOOD: `feat(finance): expose batch invoice export with truncation flag`",
    "",
    "BAD:  `refactor: refactor auth code`  (verb echoing type, no noun)",
    "GOOD: `refactor(auth): split token-refresh out of session middleware`",
    "",
    "BAD body: `Updated payments.service.ts, expenses.service.ts, and 3 other files.`",
    "GOOD body:",
    "  `Fund lock was acquired inside the Mongo transaction, so a busy Redis`",
    "  `lock held the session open past its 3s deadline and broke the next`",
    "  `write attempt. Move acquisition before transaction start so the`",
    "  `session is only opened once the lock is held.`",
    "",
    "Hard rules:",
    "- Do NOT include code fences (```), markdown headings (#), or any prose outside the message itself.",
    '- Do NOT add a "Generated by" / "Co-Authored-By" / "Signed-off-by" trailer — the bridge appends its own.',
    '- Do NOT describe files mechanically ("updated 5 files", "modified config.ts"). Describe runtime behavior.',
    '- Do NOT pad with filler ("This commit ...", "The purpose of this change is ..."). Get to the point.',
    "- If the diff is genuinely empty after investigation, output exactly: `chore: no changes`",
    "",
    "Output ONLY the commit message itself. No explanation, no preamble, no closing remarks.",
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
