/**
 * Prompt-size auditor.
 *
 *   bun scripts/audit-prompts.ts                # synthetic samples
 *   bun scripts/audit-prompts.ts --task t_…     # real task from sessions/
 *   bun scripts/audit-prompts.ts --json         # machine-readable output
 *
 * Renders the coordinator template + a representative child prompt the
 * way the bridge actually does, then prints byte size, approximate
 * token count (chars/4 — a coarse but consistent yardstick), and a
 * per-section breakdown so it's obvious where the bloat sits.
 *
 * Use it before/after touching `prompts/coordinator.md` or
 * `libs/childPrompt.ts` to make sure changes shrink (not grow) the
 * spawn cost. CI can wire it up with `--json` and a regression check.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { buildChildPrompt } from "../libs/childPrompt";
import type { RepoProfile } from "../libs/repoProfile";

const REPO_ROOT = (() => {
  const here = fileURLToPath(new URL(".", import.meta.url));
  // scripts/ lives at the repo root; this file is scripts/audit-prompts.ts
  return join(here, "..");
})();

const args = parseArgs(process.argv.slice(2));

interface CliArgs {
  taskId: string | null;
  json: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  let taskId: string | null = null;
  let json = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--task") {
      taskId = argv[++i] ?? null;
    } else if (a === "--json") {
      json = true;
    } else if (a === "--help" || a === "-h") {
      console.log("usage: bun scripts/audit-prompts.ts [--task <id>] [--json]");
      process.exit(0);
    }
  }
  return { taskId, json };
}

interface SectionStat {
  header: string;
  chars: number;
  tokens: number;
}

interface PromptStat {
  label: string;
  chars: number;
  tokens: number;
  sections: SectionStat[];
}

const APPROX_CHARS_PER_TOKEN = 4;

function approxTokens(chars: number): number {
  return Math.round(chars / APPROX_CHARS_PER_TOKEN);
}

/**
 * Split a prompt by `## Header` sections so the auditor can attribute
 * bytes to each labeled chunk. Anything before the first `## ` lands
 * in a synthetic `<preamble>` row so the totals balance.
 */
function sectionize(text: string): SectionStat[] {
  const lines = text.split("\n");
  const sections: SectionStat[] = [];
  let currentHeader = "<preamble>";
  let currentBuf: string[] = [];
  for (const line of lines) {
    const m = /^##\s+(.*?)$/.exec(line);
    if (m) {
      flush();
      currentHeader = m[1].trim();
      currentBuf = [line];
    } else {
      currentBuf.push(line);
    }
  }
  flush();
  return sections.filter((s) => s.chars > 0);

  function flush() {
    const body = currentBuf.join("\n");
    sections.push({
      header: currentHeader,
      chars: body.length,
      tokens: approxTokens(body.length),
    });
  }
}

function statFor(label: string, prompt: string): PromptStat {
  return {
    label,
    chars: prompt.length,
    tokens: approxTokens(prompt.length),
    sections: sectionize(prompt),
  };
}

/**
 * Render the coordinator kernel the same way `libs/coordinator.ts`
 * does the substitution. We don't splice the `## Detected scope`
 * block here (that requires the detect layer + bridge.json access);
 * the audit deliberately measures the *static* template since that's
 * the cost paid on every spawn. Add `--with-scope` later if it
 * becomes useful.
 */
function renderCoordinatorTemplate(args: {
  taskId: string;
  taskTitle: string;
  taskBody: string;
  bridgeFolder: string;
  bridgeUrl: string;
  exampleRepo: string;
}): string {
  const path = join(REPO_ROOT, "prompts", "coordinator.md");
  const tpl = readFileSync(path, "utf8");
  const sessionId = "00000000-0000-0000-0000-000000000000";
  return tpl
    .replaceAll("{{SESSION_ID}}", sessionId)
    .replaceAll("{{TASK_ID}}", args.taskId)
    .replaceAll("{{BRIDGE_URL}}", args.bridgeUrl)
    .replaceAll("{{BRIDGE_FOLDER}}", args.bridgeFolder)
    .replaceAll("{{EXAMPLE_REPO}}", args.exampleRepo)
    .replaceAll("{{TASK_TITLE}}", args.taskTitle)
    .replaceAll("{{TASK_BODY}}", args.taskBody);
}

/**
 * Build a representative child prompt. By default uses synthetic
 * task data with all opt-in sections enabled at modest sizes (so the
 * audit measures the realistic upper bound of what gets sent to a
 * spawned child). When `--task` is provided we read the real task's
 * meta.json + bridge state files for a closer-to-production figure.
 */
function buildSampleChildPrompt(taskId: string | null): string {
  const sample = {
    taskTitle: taskId
      ? readTaskField(taskId, "taskTitle") ?? "Sample task"
      : "Sample task — short title",
    taskBody: taskId
      ? readTaskField(taskId, "taskBody") ?? "Sample body."
      : "Sample task body. Implement a small feature, write a couple tests, exit cleanly.",
  };

  const profile: RepoProfile = {
    name: "edusoft-lms-api",
    summary: "NestJS + Prisma + Mongo backend for an LMS.",
    stack: ["nestjs", "prisma", "mongoose", "typescript"],
    features: ["auth", "finance", "students", "ledgers"],
    entrypoints: ["src/main.ts", "src/api", "src/schemas"],
  } as unknown as RepoProfile;

  return buildChildPrompt({
    taskId: taskId ?? "t_audit_sample",
    taskTitle: sample.taskTitle,
    taskBody: sample.taskBody,
    parentSessionId: "00000000-0000-0000-0000-000000000001",
    childSessionId: "00000000-0000-0000-0000-000000000002",
    role: "coder",
    repo: "edusoft-lms-api",
    repoCwd: "D:/Edusoft/edusoft-lms-api",
    contextBlock: "## Repo context\n\nHEAD: abc1234 — fix(auth): rotate refresh tokens\nUntracked: 0\nRecent: …",
    coordinatorBody:
      "Implement the `LedgerAccountCodeService` per spec at docs/specs/ledger.md. Add unit tests under src/api/v2/finance/student-ledgers/__tests__. Out of scope: UI changes.",
    profile,
    bridgeFolder: "claude-bridge",
    houseRules: "- prefer named exports\n- no `any`\n- functions ≤ 60 lines",
    playbookBody:
      "**Coder playbook:** read the file you're about to change first, run the per-app verify chain locally before writing the report, never reformat unrelated code.",
    verifyHint: {
      typecheck: "pnpm typecheck",
      lint: "pnpm lint",
      test: "pnpm test --run",
    } as unknown as Parameters<typeof buildChildPrompt>[0]["verifyHint"],
    symbolIndex: null,
    styleFingerprint: null,
    pinnedFiles: [],
    attachedReferences: [],
    recentDirection: null,
    memoryEntries: [
      "When adding Mongoose schemas, mirror existing decorator order.",
      "Tests use vitest globals — do not import from 'vitest' explicitly.",
    ],
    detectedScope: null,
    sharedPlan: null,
  });
}

function readTaskField(taskId: string, field: "taskTitle" | "taskBody"): string | null {
  const p = join(REPO_ROOT, "sessions", taskId, "meta.json");
  if (!existsSync(p)) return null;
  try {
    const meta = JSON.parse(readFileSync(p, "utf8")) as Record<string, unknown>;
    const v = meta[field];
    return typeof v === "string" ? v : null;
  } catch {
    return null;
  }
}

function fmtKb(chars: number): string {
  if (chars < 1024) return `${chars} B`;
  return `${(chars / 1024).toFixed(1)} KB`;
}

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + " ".repeat(n - s.length);
}

function printPretty(stats: PromptStat[]): void {
  for (const s of stats) {
    console.log(`\n=== ${s.label} ===`);
    console.log(`  total: ${fmtKb(s.chars)}  ≈ ${s.tokens.toLocaleString()} tokens`);
    console.log("");
    const max = Math.max(...s.sections.map((x) => x.chars), 1);
    const labelW = Math.max(...s.sections.map((x) => x.header.length), 12);
    for (const sec of s.sections) {
      const bar = "█".repeat(Math.max(1, Math.round((sec.chars / max) * 28)));
      const pct = ((sec.chars / s.chars) * 100).toFixed(0);
      console.log(
        `  ${pad(sec.header.slice(0, labelW), labelW)}  ${pad(fmtKb(sec.chars), 8)}  ${pad(`${pct}%`, 4)}  ${bar}`,
      );
    }
  }
}

function main(): void {
  const coordinator = renderCoordinatorTemplate({
    taskId: args.taskId ?? "t_audit_sample",
    taskTitle: args.taskId ? (readTaskField(args.taskId, "taskTitle") ?? "Sample task") : "Sample task",
    taskBody: args.taskId
      ? (readTaskField(args.taskId, "taskBody") ?? "Sample body.")
      : "Sample task body — implement small feature.",
    bridgeFolder: "claude-bridge",
    bridgeUrl: "http://localhost:7777",
    exampleRepo: "edusoft-lms-api",
  });
  const child = buildSampleChildPrompt(args.taskId);

  const stats: PromptStat[] = [
    statFor("coordinator kernel (prompts/coordinator.md, post-substitution)", coordinator),
    statFor("child prompt (libs/childPrompt.ts, all opt-in sections enabled)", child),
  ];

  if (args.json) {
    console.log(JSON.stringify(stats, null, 2));
    return;
  }
  printPretty(stats);

  const total = stats.reduce((s, x) => s + x.chars, 0);
  console.log(
    `\n--- combined first-spawn cost ---\n  ${fmtKb(total)}  ≈ ${approxTokens(total).toLocaleString()} tokens (coordinator + one child)`,
  );
}

main();
