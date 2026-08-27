import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { treeKill } from "./processKill";

const CLAUDE_BIN = process.env.CLAUDE_BIN ?? "claude";
const COMMIT_MSG_TIMEOUT_MS = 45_000;
const STDOUT_CAP_BYTES = 32 * 1024;
const STDERR_CAP_BYTES = 4 * 1024;

const SUBJECT_CAP_CHARS = 72;
const SUBJECT_TARGET_CHARS = 60;

export interface GenerateCommitMessageOptions {
  cwd: string;
  taskTitle?: string;
  timeoutMs?: number;
  nameStatus?: string;
  diff?: string;
  diffTruncated?: boolean;
}

export interface GenerateCommitMessageResult {
  message: string;
  source: "llm";
}

const CORRECTIVE_SUFFIX = [
  "",
  "---",
  "Your previous attempt was REJECTED. It was either malformed (not exactly `<type>(<scope>): <subject>`) or mechanical (a file list / `update N files`-style subject that describes WHICH files changed instead of WHAT the change does).",
  "Re-read the diff above and write the SEMANTIC change — the behavior, contract, or invariant that shifted. Output ONLY the corrected commit message, nothing else.",
].join("\n");

const RETRY_TIMEOUT_MS = 30_000;

async function attempt(
  opts: GenerateCommitMessageOptions,
  corrective: boolean,
): Promise<GenerateCommitMessageResult | null> {
  const prompt = buildPrompt(opts) + (corrective ? CORRECTIVE_SUFFIX : "");
  const timeoutMs = corrective
    ? Math.min(opts.timeoutMs ?? COMMIT_MSG_TIMEOUT_MS, RETRY_TIMEOUT_MS)
    : opts.timeoutMs;
  const raw = await runClaude(prompt, opts.cwd, timeoutMs);
  if (!raw) return null;
  const parsed = parseLLMResponse(raw);
  if (!parsed) return null;
  if (isFileListShaped(parsed)) return null;
  return { message: parsed, source: "llm" };
}

export async function generateCommitMessageWithLLM(
  opts: GenerateCommitMessageOptions,
): Promise<GenerateCommitMessageResult | null> {
  try {
    if (!existsSync(opts.cwd)) return null;
    const first = await attempt(opts, false);
    if (first) return first;
    return await attempt(opts, true);
  } catch (err) {
    console.warn("[commit-message] generate crashed (non-fatal)", err);
    return null;
  }
}

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

  if ((opts.nameStatus && opts.nameStatus.trim()) || (opts.diff && opts.diff.trim())) {
    lines.push(
      "The change set is provided below — read it and describe what it DOES. The `git` commands above are optional; use them only to read more than what's shown (an untracked file's body, or a truncated section).",
      "",
      "── Changed files ──",
      (opts.nameStatus && opts.nameStatus.trim()) || "(see diff)",
      "",
    );
    if (opts.diff && opts.diff.trim()) {
      lines.push(
        "── Diff ──" +
          (opts.diffTruncated ? " (TRUNCATED — run `git diff HEAD` for the remainder if the tail matters)" : ""),
        opts.diff.trim(),
        "",
      );
    }
  }

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
      ["-p", "--permission-mode", "bypassPermissions"],
      {
        cwd,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      },
    );
    child.stdin.on("error", () => { });
    child.stdin.write(prompt, "utf8");
    child.stdin.end();

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

export function parseLLMResponse(raw: string): string | null {
  if (!raw || raw.trim().length === 0) return null;
  let text = raw;

  const fenceMatch = text.match(/^\s*```[^\n]*\n([\s\S]*?)\n```\s*$/);
  if (fenceMatch) text = fenceMatch[1];

  const rawLines = text.split(/\r?\n/);
  let i = 0;
  while (i < rawLines.length) {
    const l = rawLines[i];
    if (l.trim().length === 0) { i++; continue; }
    if (/^#+\s/.test(l)) { i++; continue; }
    if (i < 4 && !looksLikeHeader(l)) { i++; continue; }
    break;
  }
  if (i >= rawLines.length) return null;

  const headerLine = rawLines[i];
  if (!looksLikeHeader(headerLine)) return null;

  let subject = headerLine.trim();
  if (subject.length > SUBJECT_CAP_CHARS) {
    const hard = SUBJECT_CAP_CHARS - 1;
    let cut = subject.slice(0, hard);
    const lastSpace = cut.lastIndexOf(" ");
    if (lastSpace > 0 && lastSpace >= hard - 16) cut = cut.slice(0, lastSpace);
    subject = cut.replace(/[\s,;:_–-]+$/, "") + "…";
  }

  const bodyLines: string[] = [];
  for (let j = i + 1; j < rawLines.length; j++) {
    const l = rawLines[j];
    if (/^\s*Co-Authored-By:/i.test(l)) continue;
    if (/^\s*Generated by Claude/i.test(l)) continue;
    bodyLines.push(l);
  }

  while (bodyLines.length > 0 && bodyLines[0].trim().length === 0) bodyLines.shift();
  while (bodyLines.length > 0 && bodyLines[bodyLines.length - 1].trim().length === 0) bodyLines.pop();
  const body = collapseBlankRuns(bodyLines).join("\n").trim();

  return body.length > 0 ? `${subject}\n\n${body}` : subject;
}

export function isFileListShaped(message: string): boolean {
  const lines = message.split(/\r?\n/);
  const subject = (lines[0] ?? "").trim();
  if (/\b\d+\s+files?\b/i.test(subject)) return true;
  if (/^[a-z]+(\([^)]*\))?:\s*(update|change|modify|edit|touch)\s+[\w./-]+\.\w+\s*$/i.test(subject)) {
    return true;
  }
  const body = lines.slice(1).map((l) => l.trim()).filter((l) => l.length > 0);
  if (body.length >= 2) {
    const fileOp = /^[-*]\s*(add|update|remove|delete|rename|modify|change|create|touch|copy)\b.*[\/.]\w+/i;
    if (body.every((l) => fileOp.test(l))) return true;
  }
  return false;
}

function looksLikeHeader(line: string): boolean {
  const m = /^([a-z]+)(?:\([^)]+\))?:\s+\S/.exec(line.trim());
  return !!m && VALID_TYPES.has(m[1]);
}

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
