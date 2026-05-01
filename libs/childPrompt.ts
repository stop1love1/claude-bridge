/**
 * Standardized prompt wrapper for spawned child agents.
 *
 * The bridge wraps every child spawn (POST /api/tasks/<id>/agents) so the
 * coordinator only has to write the role-specific brief — all the boilerplate
 * (task header, language directive, repo profile, pre-warmed context,
 * self-register snippet, report contract) is added by `buildChildPrompt`.
 *
 * Section order is contract: the coordinator's aggregator parses the report
 * by section header, and children rely on the wrapper's structure to know
 * what's expected. Keep additions append-only, don't reorder.
 */
import type { RepoProfile } from "./repoProfile";
import type { AppVerify } from "./apps";
import type { SymbolIndex, SymbolEntry } from "./symbolIndex";
import type { StyleFingerprint } from "./styleFingerprint";
import type { PinnedFile } from "./pinnedFiles";
import type { ReferenceFile } from "./contextAttach";
import type { RecentDirection } from "./recentDirection";
import type { DetectedScope } from "./detect/types";
import { renderDetectedScope } from "./detect/render";
import { BRIDGE_URL, BRIDGE_FOLDER } from "./paths";

export interface BuildChildPromptOpts {
  taskId: string;
  taskTitle: string;
  taskBody: string;
  parentSessionId: string;
  childSessionId: string;
  role: string;
  repo: string;
  repoCwd: string;
  /** Pre-warmed repo context (git status / log / ls-files). Optional. */
  contextBlock?: string;
  /** The role-specific instructions the coordinator wrote. Untrusted. */
  coordinatorBody: string;
  /** Cached profile for the target repo, if any. */
  profile?: RepoProfile;
  /**
   * Folder name of the bridge itself (where reports go).
   * Defaults to the runtime-detected `BRIDGE_FOLDER` from `paths.ts`,
   * but tests / non-default deployments can override.
   */
  bridgeFolder?: string;
  /**
   * (P1/C3) Pre-loaded global+per-app `house-rules.md` markdown. Rendered
   * verbatim into a `## House rules` section after `## Language` so the
   * agent reads team constraints before the task body. Null/undefined =
   * skip the section entirely.
   */
  houseRules?: string | null;
  /**
   * (P1/H1) Pre-loaded `prompts/playbooks/<role>.md` markdown. When
   * present, prepended to the coordinator brief inside `## Your role`
   * so the role contract is visible before the task-specific brief.
   * Null/undefined = render only the coordinator body (current behavior).
   */
  playbookBody?: string | null;
  /**
   * (P1/D1) Per-app verify contract from `bridge.json`. When at least
   * one command is set, rendered as a `## Verify commands` section so
   * the agent self-checks before writing its report. P2 will exec these
   * automatically — surfacing them in P1 lets agents catch issues before
   * the bridge has to.
   */
  verifyHint?: AppVerify | null;
  /**
   * (P3a/A2) Symbol index for the target app — top-level exports
   * extracted from `lib/`, `utils/`, `hooks/`, `components/ui/` (or
   * the dirs the operator overrode in `bridge.json.symbolDirs`).
   * Rendered as a `## Available helpers` section so the agent knows
   * what already exists and reaches for it instead of writing a new
   * util that duplicates one already in the codebase. Null/undefined
   * = skip the section.
   */
  symbolIndex?: SymbolIndex | null;
  /**
   * (P3a/A1) Per-app style fingerprint — auto-detected indent / quote
   * / semicolon / export / file-naming preferences. Rendered as a
   * compact `## House style (auto-detected)` section so the agent
   * matches the codebase's micro-style without the operator having
   * to hand-write rules in house-rules.md. Null/undefined = skip.
   */
  styleFingerprint?: StyleFingerprint | null;
  /**
   * (P3a/B3) Pinned files declared in `bridge.json.pinnedFiles`,
   * pre-loaded as `{ rel, content, truncated }`. Rendered as a
   * `## Pinned context` section with each file in its own fenced
   * code block. Empty list = skip the section.
   */
  pinnedFiles?: PinnedFile[];
  /**
   * (P3b/B2) Auto-attached reference files chosen heuristically from
   * the symbol index using task-body keyword overlap. Rendered as
   * `## Reference files` distinct from `## Pinned context` so the
   * agent knows these were AI-picked vs operator-pinned. Empty list
   * = skip the section.
   */
  attachedReferences?: ReferenceFile[];
  /**
   * (P3b/B4) Recent git activity in the focus dir the bridge inferred
   * from the task body. Rendered as `## Recent direction` after
   * `## Repo context` so the agent sees what's been actively
   * changing in the area it's about to touch. Null = skip.
   */
  recentDirection?: RecentDirection | null;
  /**
   * (P5/G1) Per-app memory entries — durable learnings from prior
   * tasks. Rendered as `## Memory` after `## House style` so the
   * agent reads accreted rules right next to the static team
   * constraints. Empty list = skip.
   */
  memoryEntries?: string[];
  /**
   * (Detect) Cached `DetectedScope` for the task — same value the
   * coordinator saw. Rendered as `## Detected scope` after `## Task`
   * so the child can see what features / entities / files / repos the
   * bridge identified before it dives into the role-specific brief.
   * Null/undefined = no scope cached (legacy task / detect disabled).
   */
  detectedScope?: DetectedScope | null;
  /**
   * (Planner) Contents of `sessions/<task-id>/plan.md` if a planner
   * agent has already drafted one for this task. Rendered as a
   * `## Shared plan (from planner)` section right before `## Your role`
   * so every downstream coder/reviewer reads the agreed cross-repo
   * contracts and breakdown before diving into their own brief.
   * Null/undefined/empty = no planner has run yet — section omitted.
   *
   * The agents route loads this file for every spawn (cheap — one stat
   * + one read), so any role that runs after the planner sees the same
   * shared plan automatically. The planner itself sees it too on
   * re-dispatch, which lets it refine instead of starting over.
   */
  sharedPlan?: string | null;
}

const COORDINATOR_BODY_CAP = 16 * 1024;

/**
 * Render a profile entry as a human-readable bullet. Defensive against
 * partially-populated profiles (no stack/features/entrypoints).
 */
function renderProfileLine(p: RepoProfile): string {
  const summary = p.summary?.trim() || `${p.name} — (no summary)`;
  const stack = p.stack.length > 0 ? p.stack.join(", ") : "(unknown)";
  const features = p.features.length > 0 ? p.features.join(", ") : "(none detected)";
  const entrypoints = p.entrypoints.length > 0
    ? p.entrypoints.slice(0, 4).join(", ")
    : "(unknown)";
  return `- **${p.name}** — ${summary} Stack: ${stack}. Features: ${features}. Entrypoints: ${entrypoints}.`;
}

/**
 * Sanitize untrusted coordinator-authored text. We don't try deep escaping —
 * the body is markdown-in-markdown — just a length cap so a runaway
 * coordinator can't blow out the context window for the child.
 */
function sanitizeCoordinatorBody(body: string): string {
  const trimmed = (body ?? "").trim();
  if (trimmed.length === 0) {
    return "(coordinator did not provide a role-specific brief — work from the task body and your role label alone)";
  }
  if (trimmed.length <= COORDINATOR_BODY_CAP) return trimmed;
  return (
    trimmed.slice(0, COORDINATOR_BODY_CAP) +
    "\n\n…(truncated by bridge — coordinator brief exceeded 16 KB cap)"
  );
}

/**
 * Strip any sequence that would terminate the fenced code block we
 * embed `taskBody` inside (`\n```\n` at column 0, with any number of
 * leading backticks ≥ 3). User-supplied content with a literal triple
 * backtick on its own line would otherwise close the wrapper fence
 * early and inject arbitrary markdown / instructions into the child
 * prompt.
 *
 * Earlier this used a zero-width joiner injection that some LLMs strip
 * during input normalization, defeating the guard. Switched to a more
 * robust substitution that breaks the fence syntax outright by
 * inserting a U+200B (ZERO-WIDTH SPACE) between the prefix whitespace
 * and the backticks AND degrading the fence to indented-code form via
 * a leading regular space — markdown parsers treat ``` after a space
 * as inline code or plain text, not a fence boundary, regardless of
 * what the LLM does with the ZWSP.
 */
export function sanitizeTaskBodyForFence(body: string): string {
  return (body ?? "").replace(/^(\s*)(`{3,})/gm, "$1​ ​$2");
}

/**
 * Defang structural markers that would let user-supplied task content
 * hijack the coordinator template. Two attack surfaces:
 *
 *   1. The `{{...}}` template placeholders: a body that contains the
 *      literal text `{{TASK_BODY}}` could be substituted recursively
 *      if the substitution order ever changed, leaking template state.
 *   2. The `## Your job` splice marker the coordinator uses to insert
 *      the detected-scope block: a body containing that line would
 *      cause `spliceScopeBlock` to inject the scope at an
 *      attacker-controlled position, and any subsequent `## Your job`
 *      heading shifted into earlier substitution would alter intent.
 *
 * We replace both patterns with a visually-similar but inert variant
 * (the LLM still reads them, but no template / splice code matches).
 */
export function sanitizeUserPromptContent(input: string): string {
  if (!input) return "";
  return input
    // {{X}} → ｛｛X｝｝ (fullwidth braces — LLM-readable, not a placeholder)
    .replace(/\{\{/g, "｛｛")
    .replace(/\}\}/g, "｝｝")
    // `## Your job` (and a couple of close variants) → degrade the
    // heading by inserting a ZWSP after the leading hashes so it is
    // no longer matched by `indexOf("## Your job")` anywhere.
    .replace(/^(#{1,6})(\s+Your job\b)/gim, "$1​$2");
}

/**
 * Build the full child prompt. Pure function — no I/O.
 *
 * Output sections, in order (sections marked OPT-IN are emitted only
 * when the corresponding input is present):
 *   1. Header line (role, task id, repo, cwd, dispatcher disclaimer)
 *   2. ## Language
 *   3. ## House rules                            (OPT-IN — opts.houseRules)
 *   4. ## House style (auto-detected)            (OPT-IN — opts.styleFingerprint)
 *   5. ## Memory                                 (OPT-IN — opts.memoryEntries)
 *   6. ## Task
 *   7. ## Detected scope                         (OPT-IN — opts.detectedScope)
 *   8. ## Shared plan (from planner)             (OPT-IN — opts.sharedPlan)
 *   9. ## Your role (playbook prepended if any, then coordinator brief)
 *  10. ## Repo profile
 *  11. ## Available helpers                      (OPT-IN — opts.symbolIndex)
 *  12. ## Repo context (auto-captured by bridge)
 *  13. ## Recent direction                       (OPT-IN — opts.recentDirection)
 *  14. ## Pinned context                         (OPT-IN — opts.pinnedFiles)
 *  15. ## Reference files                        (OPT-IN — opts.attachedReferences)
 *  16. ## Self-register
 *  17. ## Report contract — REQUIRED
 *  18. ## Verify commands                        (OPT-IN — opts.verifyHint)
 *  19. ## Spawn-time signals
 */
export function buildChildPrompt(opts: BuildChildPromptOpts): string {
  const {
    taskId,
    taskTitle,
    taskBody,
    parentSessionId,
    childSessionId,
    role,
    repo,
    repoCwd,
    contextBlock,
    coordinatorBody,
    profile,
    bridgeFolder = BRIDGE_FOLDER,
    houseRules,
    playbookBody,
    verifyHint,
    symbolIndex,
    styleFingerprint,
    pinnedFiles,
    attachedReferences,
    recentDirection,
    memoryEntries,
    detectedScope,
    sharedPlan,
  } = opts;

  const safeBody = sanitizeCoordinatorBody(coordinatorBody);
  const safeTaskBody = sanitizeTaskBodyForFence(taskBody);
  const profileLine = profile
    ? renderProfileLine(profile)
    : `(no profile cached — call \`GET ${BRIDGE_URL}/api/repos/profiles\` to refresh)`;
  const ctx = (contextBlock ?? "").trim() || "(none — bridge skipped pre-warm)";

  const lines: string[] = [
    `You are a \`${role}\` agent dispatched by the bridge coordinator for task \`${taskId}\`. You run inside \`${repo}\` (cwd resolves to \`${repoCwd}\`). You are NOT the coordinator — your job is the specific task below; you do not orchestrate, you do not spawn other agents, you produce one report and exit.`,
    "",
    "## Language",
    "",
    "Mirror the language of the task body (whatever it is) in every reply, code comment narration, and the final report. Identifier-level text (file paths, function names, JSON keys, shell commands) stays in English.",
    "",
  ];

  const houseRulesTrimmed = (houseRules ?? "").trim();
  if (houseRulesTrimmed.length > 0) {
    lines.push(
      "## House rules",
      "",
      "Team constraints that apply to every change in this codebase. Treat as hard requirements — violating one means the work will be rejected at review.",
      "",
      houseRulesTrimmed,
      "",
    );
  }

  const styleLines = renderStyleFingerprintLines(styleFingerprint);
  if (styleLines.length > 0) {
    lines.push(
      "## House style (auto-detected)",
      "",
      "Match these conventions in any new or edited code. Auto-detected from a sample of the codebase, so they reflect what the team actually writes — not a stale style guide. Mismatches won't fail the build but will read as alien.",
      "",
      ...styleLines,
      "",
    );
  }

  if (memoryEntries && memoryEntries.length > 0) {
    lines.push(
      "## Memory (learnings from prior tasks in this app)",
      "",
      "Durable rules accreted from past tasks in this app. Treat each as a soft requirement — the team chose to remember it for a reason. Only deviate when the current task body explicitly overrides.",
      "",
      ...memoryEntries.map((e) => (e.startsWith("-") ? e : `- ${e}`)),
      "",
    );
  }

  lines.push(
    "## Task",
    "",
    `- ID: \`${taskId}\``,
    `- Title: ${taskTitle}`,
    "- Original body (verbatim from the user):",
    "",
    "  ```",
    safeTaskBody,
    "  ```",
    "",
  );

  if (detectedScope) {
    lines.push(
      renderDetectedScope(detectedScope, { forCoordinator: false }),
    );
  }

  const sharedPlanTrimmed = (sharedPlan ?? "").trim();
  if (sharedPlanTrimmed.length > 0) {
    lines.push(
      "## Shared plan (from planner)",
      "",
      "A planner agent already drafted the cross-repo breakdown and contracts for this task. **Treat the contracts as authoritative** — if your role would deviate from a documented contract, stop and surface that as a `NEEDS-DECISION` instead of silently going your own way (the other repo's coder is reading the same plan and assuming you'll follow it). The work breakdown and conventions are guidance — match them when reasonable, deviate with a one-line note in your report when you find new info that invalidates an assumption.",
      "",
      sharedPlanTrimmed,
      "",
    );
  }

  lines.push(
    "## Your role",
    "",
    `\`${role}\` in \`${repo}\`. The coordinator wrote the role-specific brief below — read it carefully:`,
    "",
    "---",
    "",
  );

  const playbookTrimmed = (playbookBody ?? "").trim();
  if (playbookTrimmed.length > 0) {
    lines.push(
      `**Role playbook (\`${role}\`):**`,
      "",
      playbookTrimmed,
      "",
      "---",
      "",
      "**Task-specific brief (from coordinator):**",
      "",
    );
  }

  lines.push(
    safeBody,
    "",
    "---",
    "",
    "## Repo profile",
    "",
    profileLine,
    "",
  );

  const symbolLines = renderSymbolIndexLines(symbolIndex);
  if (symbolLines.length > 0) {
    lines.push(
      "## Available helpers",
      "",
      "Top-level exports already in this codebase. Reuse these instead of writing a new utility — duplicating an existing helper is the fastest way to ship code that reads as alien. Auto-extracted from `lib/`, `utils/`, `hooks/`, `components/ui/` (override via `bridge.json.symbolDirs`).",
      "",
      ...symbolLines,
      "",
    );
  }

  lines.push(
    "## Repo context (auto-captured by bridge)",
    "",
    ctx,
    "",
  );

  const recentLines = renderRecentDirectionLines(recentDirection);
  if (recentLines.length > 0) {
    lines.push(
      "## Recent direction",
      "",
      "Last 10 commits that touched the dir the task is most likely focused on. Use this to see what conventions are being established right now (the static profile data above can lag a refactor by days).",
      "",
      ...recentLines,
      "",
    );
  }

  const pinnedLines = renderPinnedFilesLines(pinnedFiles);
  if (pinnedLines.length > 0) {
    lines.push(
      "## Pinned context",
      "",
      "Files the operator pinned for this app — canonical examples, type files, routing manifests. Treat them as authoritative for shape and convention; if your work needs to differ, justify in your report.",
      "",
      ...pinnedLines,
      "",
    );
  }

  const referenceLines = renderReferenceFilesLines(attachedReferences);
  if (referenceLines.length > 0) {
    lines.push(
      "## Reference files",
      "",
      "Files the bridge auto-picked based on task-body keyword overlap with the symbol index. These are the **closest examples already in the codebase** to what the task is asking for — match their patterns. Lower-priority than `## Pinned context` (operator-curated) but higher-signal than the rest of the repo.",
      "",
      ...referenceLines,
      "",
    );
  }

  lines.push(
    "## Self-register",
    "",
    `Your session UUID is \`${childSessionId}\` — already passed via \`--session-id\`. The bridge has pre-registered your run in \`meta.json\`. Confirm registration once via:`,
    "",
    "```bash",
    `curl -s -X POST ${BRIDGE_URL}/api/tasks/${taskId}/link \\`,
    `  -H "content-type: application/json" \\`,
    `  -H "x-bridge-internal-token: $BRIDGE_INTERNAL_TOKEN" \\`,
    `  -d '{"sessionId":"${childSessionId}","role":"${role}","repo":"${repo}","status":"running"}'`,
    "```",
    "",
    "**Do NOT re-POST `status:\"done\"` at the end.** The bridge's lifecycle hook flips your run from `running → done` automatically when this turn ends cleanly (or `failed` on non-zero exit). Self-POSTing `done` while you're still streaming the final summary makes the UI show DONE before the user sees your reply. The only legitimate self-POST is the initial `running` confirmation above.",
    "",
    "## Report contract — REQUIRED",
    "",
    "**Escalation rule — read this first.** If the task body is ambiguous, you face a multi-option choice, or you need approval before proceeding: **DO NOT guess.** Stop, set verdict to `NEEDS-DECISION`, fill `## Questions for the user` with concrete options + your recommendation, and exit cleanly. The coordinator forwards the questions to the user; once answered, the bridge re-dispatches you (or a sibling) with the answers in the new prompt. Guessing past ambiguity wastes a retry slot and ships work the user has to redo.",
    "",
    `Before you exit, write \`../${bridgeFolder}/sessions/${taskId}/reports/${role}-${repo}.md\` (\`mkdir -p\` the dir first). Use this exact schema:`,
    "",
    "```markdown",
    `# ${role} @ ${repo}`,
    "",
    "## Verdict",
    "DONE | BLOCKED | PARTIAL | NEEDS-DECISION — one line, no extra prose.",
    "- BLOCKED → the next section MUST start with `BLOCK: <reason>` so the bridge auto-retry path can read it.",
    "- NEEDS-DECISION → fill `## Questions for the user` below; skip `## Changed files` / `## How to verify` (write `(none — awaiting decision)`).",
    "",
    "## Summary",
    "2–4 sentences in the user's language describing what shipped end-to-end. No raw logs.",
    "",
    "## Questions for the user",
    "(Only required when verdict is `NEEDS-DECISION`. Otherwise omit, or write `(none)`.)",
    "For each open decision, one bullet group:",
    "- **Q1:** the question in one sentence.",
    "  - Context: 1–2 lines on why it matters / what depends on it.",
    "  - Options: `(a) …` `(b) …` `(c) …` (concrete, mutually exclusive).",
    "  - Recommendation: which option you'd pick and why, in one sentence.",
    "",
    "## Changed files",
    "- `<path>` — one-line description of the change.",
    "(Bullet per file. If you only ran read-only analysis, write `(none — analysis only)` and proceed.)",
    "",
    "## How to verify",
    "Concrete steps a human can run to confirm the work: a curl, a test command, a screen to open. 1–3 bullets.",
    "",
    "## Risks / out-of-scope",
    "- Risks introduced by this change.",
    "- Things adjacent to the task that you deliberately did not touch.",
    "(Either bullet list, or write `(none)` for both.)",
    "",
    "## Notes for the coordinator",
    "Anything the coordinator should know when aggregating: cross-repo dependencies surfaced (`NEEDS-OTHER-SIDE: <thing>`), hidden gotchas, follow-up tasks worth filing. If verdict is `NEEDS-DECISION`, flag which question is blocking the most work.",
    "```",
    "",
    "The coordinator parses these section headers exactly. Stick to the schema — adding sections is fine, removing or renaming is NOT.",
    "",
    "**Strict end-of-turn order:**",
    "1. Write the report file under `sessions/<task-id>/reports/`.",
    "2. Send your final assistant message mirroring the report's `## Summary` section.",
    "3. Stop. No more tool calls, no link re-POST, no status PATCH.",
    "",
    "Tool calls AFTER the chat reply land in the UI as trailing noise; status PATCHes flip the visible badge to DONE while you're still typing. Let the bridge's lifecycle hook close the run.",
    "",
    "**Git is bridge-managed.** Do NOT run `git checkout`, `git commit`, or `git push` yourself — the bridge already prepared the branch before your spawn and will (if the app is configured for it) auto-commit + auto-push after you exit cleanly. Duplicating those commands races the lifecycle hook and produces empty / conflicting commits. Write code, write the report, exit.",
    "",
  );

  const verifyEntries = renderVerifyEntries(verifyHint);
  if (verifyEntries.length > 0) {
    lines.push(
      "## Verify commands",
      "",
      "Run these locally before writing your report. Each one is the team's source of truth for `it works` — your report's `## How to verify` section should reference them. P2 of the bridge will exec these automatically; for now, running them yourself catches problems before the report goes out.",
      "",
      ...verifyEntries,
      "",
    );
  }

  lines.push(
    "## Spawn-time signals",
    "",
    `- Bridge heuristic suggested target repo: \`${repo}\` (this is you).`,
    `- Parent coordinator session: \`${parentSessionId}\` — for cross-referencing in your report.`,
    "",
  );

  return lines.join("\n");
}

/**
 * Render the AppVerify object as bullet lines for the `## Verify
 * commands` section. Returns an empty array when there's nothing to
 * surface so the caller can skip the section header entirely.
 */
function renderVerifyEntries(v: AppVerify | null | undefined): string[] {
  if (!v) return [];
  const out: string[] = [];
  const ordered: Array<[keyof AppVerify, string]> = [
    ["typecheck", "Typecheck"],
    ["lint", "Lint"],
    ["format", "Format"],
    ["test", "Test"],
    ["build", "Build"],
  ];
  for (const [key, label] of ordered) {
    const cmd = v[key];
    if (typeof cmd === "string" && cmd.trim().length > 0) {
      out.push(`- **${label}** — \`${cmd.trim()}\``);
    }
  }
  return out;
}

/**
 * (P3a/A2) Render the symbol index as bullet lines grouped by kind.
 * Components first (most useful for UI repos), then plain helpers.
 * Caps at 30 entries to keep prompt token cost predictable; the
 * `+N more` line tells the agent how many were truncated.
 */
const SYMBOLS_PROMPT_CAP = 30;
function renderSymbolIndexLines(
  index: SymbolIndex | null | undefined,
): string[] {
  if (!index || !index.symbols || index.symbols.length === 0) return [];

  // Stable sort: components first, then by file path, then by name.
  const sorted = [...index.symbols].sort((a, b) => {
    const aComp = a.kind === "component" ? 0 : 1;
    const bComp = b.kind === "component" ? 0 : 1;
    if (aComp !== bComp) return aComp - bComp;
    if (a.file !== b.file) return a.file.localeCompare(b.file);
    return a.name.localeCompare(b.name);
  });

  const shown = sorted.slice(0, SYMBOLS_PROMPT_CAP);
  const extra = sorted.length - shown.length;

  const out: string[] = [];
  let lastFile = "";
  for (const s of shown) {
    if (s.file !== lastFile) {
      if (lastFile !== "") out.push("");
      out.push(`From \`${s.file}\`:`);
      lastFile = s.file;
    }
    const sigSuffix = s.signature ? ` — \`${s.signature}\`` : "";
    out.push(`- \`${s.name}\` *(${s.kind})*${sigSuffix}`);
  }
  if (extra > 0) {
    out.push("", `…and **${extra}** more — full list in \`.bridge-state/symbol-indexes.json\`.`);
  }
  // Quiet a possible unused-symbol warning when SymbolEntry isn't
  // referenced by name elsewhere in this file.
  void (null as unknown as SymbolEntry | null);
  return out;
}

/**
 * (P3a/A1) Render the style fingerprint as 5-7 short lines. Skips
 * dimensions where the auto-detector returned `unknown` so we don't
 * give the agent confidence-less guidance ("indent: unknown" is
 * worse than no advice).
 */
function renderStyleFingerprintLines(
  fp: StyleFingerprint | null | undefined,
): string[] {
  if (!fp) return [];
  const out: string[] = [];

  if (fp.indent.kind === "spaces") {
    out.push(`- Indent: **${fp.indent.width} spaces**`);
  } else if (fp.indent.kind === "tabs") {
    out.push(`- Indent: **tabs**`);
  }
  if (fp.quotes !== "unknown") {
    const label =
      fp.quotes === "single" ? "single (`'…'`)" :
      fp.quotes === "double" ? "double (`\"…\"`)" :
      "mixed (no clear preference)";
    out.push(`- String quotes: ${label}`);
  }
  if (fp.semicolons !== "unknown") {
    const label =
      fp.semicolons === "always" ? "always — terminate every statement" :
      fp.semicolons === "never" ? "never — ASI, no trailing semicolons" :
      "mixed (no clear preference)";
    out.push(`- Semicolons: ${label}`);
  }
  if (fp.trailingComma !== "unknown") {
    const label =
      fp.trailingComma === "all" ? "always (multi-line lists)" :
      fp.trailingComma === "none" ? "never" :
      "mixed";
    out.push(`- Trailing commas: ${label}`);
  }
  if (fp.exports !== "unknown") {
    const label =
      fp.exports === "named" ? "**named exports** preferred (default exports rare)" :
      fp.exports === "default" ? "**default exports** preferred" :
      "mixed (named + default both common)";
    out.push(`- Module exports: ${label}`);
  }
  if (fp.fileNaming.tsx !== "unknown") {
    out.push(`- \`.tsx\` file naming: **${fp.fileNaming.tsx}**`);
  }
  if (fp.fileNaming.ts !== "unknown" && fp.fileNaming.ts !== fp.fileNaming.tsx) {
    out.push(`- \`.ts\` file naming: **${fp.fileNaming.ts}**`);
  }

  if (out.length === 0) return [];
  out.push(
    "",
    `_Detected from ${fp.sampledFiles} file(s); refresh after major refactors via the apps page._`,
  );
  return out;
}

/**
 * (P3a/B3) Render pinned files as fenced code blocks, one per file.
 * The fence language is inferred from the file extension when
 * possible — helps the LLM tokenizer treat the contents as code
 * rather than prose. Truncated files get a trailing marker line.
 */
function renderPinnedFilesLines(
  files: PinnedFile[] | null | undefined,
): string[] {
  if (!files || files.length === 0) return [];
  const out: string[] = [];
  for (let i = 0; i < files.length; i++) {
    if (i > 0) out.push("");
    const f = files[i];
    const lang = inferLang(f.rel);
    out.push(`### \`${f.rel}\``, "", "```" + lang, f.content);
    if (f.truncated) {
      out.push(`…(bridge: file truncated at 4 KB)`);
    }
    out.push("```");
  }
  return out;
}

function inferLang(file: string): string {
  const dot = file.lastIndexOf(".");
  if (dot <= 0) return "";
  const ext = file.slice(dot + 1).toLowerCase();
  const map: Record<string, string> = {
    ts: "ts", tsx: "tsx", js: "js", jsx: "jsx", mjs: "js", cjs: "js",
    json: "json", md: "md", yml: "yaml", yaml: "yaml",
    py: "python", go: "go", rs: "rust", java: "java", rb: "ruby",
    sh: "bash", css: "css", html: "html",
  };
  return map[ext] ?? "";
}

/**
 * (P3b/B2) Render auto-attached reference files. Same fenced-block
 * shape as `renderPinnedFilesLines` so the agent's tokenizer treats
 * the body as code, plus a one-line score badge per file so the
 * agent knows WHY each was attached.
 */
function renderReferenceFilesLines(
  files: ReferenceFile[] | null | undefined,
): string[] {
  if (!files || files.length === 0) return [];
  const out: string[] = [];
  for (let i = 0; i < files.length; i++) {
    if (i > 0) out.push("");
    const f = files[i];
    const lang = inferLang(f.rel);
    out.push(
      `### \`${f.rel}\` _(score ${f.score})_`,
      "",
      "```" + lang,
      f.content,
    );
    if (f.truncated) {
      out.push(`…(bridge: file truncated at 4 KB)`);
    }
    out.push("```");
  }
  return out;
}

/**
 * (P3b/B4) Render the recent-direction window as a fenced diff-stat
 * block. Single block per spawn (we always pick one focus dir, not a
 * list).
 */
function renderRecentDirectionLines(
  direction: RecentDirection | null | undefined,
): string[] {
  if (!direction) return [];
  const out: string[] = [
    `Focus dir: \`${direction.dir}\` (auto-picked from task body)`,
    "",
    "```",
    direction.log,
  ];
  if (direction.truncated) {
    out.push(`…(bridge: log truncated to 30 lines)`);
  }
  out.push("```");
  return out;
}
