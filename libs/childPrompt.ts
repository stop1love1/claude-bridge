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
  contextBlock?: string;
  coordinatorBody: string;
  profile?: RepoProfile;
  bridgeFolder?: string;
  houseRules?: string | null;
  playbookBody?: string | null;
  verifyHint?: AppVerify | null;
  symbolIndex?: SymbolIndex | null;
  styleFingerprint?: StyleFingerprint | null;
  pinnedFiles?: PinnedFile[];
  attachedReferences?: ReferenceFile[];
  recentDirection?: RecentDirection | null;
  memoryEntries?: string[];
  detectedScope?: DetectedScope | null;
  sharedPlan?: string | null;
  peerNotes?: string | null;
  verdictFileName?: string | null;
}

const COORDINATOR_BODY_CAP = 16 * 1024;

function renderProfileLine(p: RepoProfile): string {
  const summary = p.summary?.trim() || `${p.name} — (no summary)`;
  const stack = p.stack.length > 0 ? p.stack.join(", ") : "(unknown)";
  const features = p.features.length > 0 ? p.features.join(", ") : "(none detected)";
  const entrypoints = p.entrypoints.length > 0
    ? p.entrypoints.slice(0, 4).join(", ")
    : "(unknown)";
  return `- **${p.name}** — ${summary} Stack: ${stack}. Features: ${features}. Entrypoints: ${entrypoints}.`;
}

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

export function sanitizeTaskBodyForFence(body: string): string {
  return (body ?? "").replace(/^(\s*)(`{3,})/gm, "$1​ ​$2");
}

function renderVerdictFileLines(
  verdictFileName: string | null | undefined,
  taskId: string,
  bridgeFolder: string,
): string[] {
  const name = (verdictFileName ?? "").trim();
  if (name.length === 0) return [];
  return [
    "## Verdict file — REQUIRED",
    "",
    `Write **exactly one** verdict file for this gate, named \`${name}\`. Use that name character-for-character: the bridge reads that one path and nothing else, so a verdict written under any other name is read as no verdict at all and the gate is recorded as skipped.`,
    "",
    `Full path from your cwd: \`../${bridgeFolder}/sessions/${taskId}/${name}\` — directly in \`sessions/${taskId}/\`, a sibling of the \`reports/\` folder and not inside it. \`mkdir -p\` that directory first.`,
    "",
    "The verdict file is a separate artifact from the report described below — you write both. Your playbook gives the JSON schema for the verdict's contents. If anything else in this prompt shows a different verdict filename, the name above is the one that counts.",
    "",
  ];
}

export function sanitizeUserPromptContent(input: string): string {
  if (!input) return "";
  return input
    .replace(/\{\{/g, "｛｛")
    .replace(/\}\}/g, "｝｝")
    .replace(/^(#{1,6})(\s+Your job\b)/gim, "$1​$2");
}

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
  const safeTitle = sanitizeUserPromptContent(taskTitle).replace(/\r?\n/g, " ");
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
    `- Title: ${safeTitle}`,
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

  const sharedPlanTrimmed = sanitizeTaskBodyForFence(
    sanitizeUserPromptContent((sharedPlan ?? "").trim()),
  );
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

  const peerNotesTrimmed = sanitizeTaskBodyForFence(
    sanitizeUserPromptContent((opts.peerNotes ?? "").trim()),
  );
  if (peerNotesTrimmed.length > 0) {
    lines.push(
      "## Peer notes (from sibling agents)",
      "",
      "Other agents on this task have already left cross-cutting observations in `sessions/" + taskId + "/notes.md`. Read them before diving in — they may answer a question you're about to ask the codebase, flag a contract another sibling already chose, or warn you about a footgun. Append your OWN observations (one bullet per entry, prefixed with your role label) when you discover something a later sibling would benefit from. Don't edit or delete prior entries — append-only.",
      "",
      peerNotesTrimmed,
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
    ...renderVerdictFileLines(opts.verdictFileName, taskId, bridgeFolder),
    "## Report contract — REQUIRED",
    "",
    "**If ambiguous, escalate.** Don't guess past a multi-option choice or approval gate. Stop, set verdict `NEEDS-DECISION`, fill `## Questions for the user` (concrete options + recommendation), exit. Guessing wastes a retry slot.",
    "",
    `Before exit, write \`../${bridgeFolder}/sessions/${taskId}/reports/${role}-${repo}.md\` (\`mkdir -p\` first). Schema (headers parsed verbatim — adding is OK, renaming/removing is NOT):`,
    "",
    "```markdown",
    `# ${role} @ ${repo}`,
    "## Verdict",
    "DONE | BLOCKED | PARTIAL | NEEDS-DECISION  (one line)",
    "  · BLOCKED → next section MUST start `BLOCK: <reason>` (auto-retry reads it)",
    "  · NEEDS-DECISION → fill `## Questions for the user`; `## Changed files` / `## How to verify` = `(none — awaiting decision)`",
    "## Summary",
    "2–4 sentences, user's language, what shipped end-to-end. No raw logs.",
    "## Questions for the user",
    "(omit / `(none)` unless NEEDS-DECISION). Per question:",
    "- **Q1:** one-sentence question. Context: 1–2 lines. Options: `(a) … (b) … (c) …`. Recommendation: which + why.",
    "## Changed files",
    "- `<path>` — one-line description. (`(none — analysis only)` for read-only runs.)",
    "## How to verify",
    "1–3 bullets: curl / test command / screen to open.",
    "## Risks / out-of-scope",
    "- bullet list, or `(none)` for either.",
    "## Notes for the coordinator",
    "Cross-repo deps (`NEEDS-OTHER-SIDE: <thing>`), hidden gotchas, follow-up tasks. If NEEDS-DECISION, flag the most blocking question.",
    "```",
    "",
    "**Peer notes (cross-cutting observations for siblings):** if during your work you discover something a SIBLING agent on the same task would benefit from — a contract you chose, a footgun you hit, a file the task body didn't mention — append ONE bullet to `sessions/<task-id>/notes.md` (create the file if absent, never edit prior entries). Format: `- [<your-role>] <observation>`. Examples worth recording: \"API uses field `userId` not `user_id`, plan said the latter\", \"refunds page is in `apps/center/finance/refunds/` not `apps/lms/`\". Skip this when there's nothing genuinely cross-cutting — noise hurts later siblings more than silence does.",
    "",
    "**End-of-turn:** (1) write the report file; (2) optionally append a peer note; (3) chat reply mirrors `## Summary`; (4) stop — no tool calls, no link re-POST, no status PATCH. Trailing tool calls render as noise; the lifecycle hook closes the run.",
    "",
    "**Git is bridge-managed.** Do NOT run `git checkout` / `commit` / `push`. The bridge prepped the branch and will auto-commit/push on clean exit per app config. Duplicating races the lifecycle hook.",
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

export function buildSystemPromptAppend(opts: BuildChildPromptOpts): string {
  const {
    profile,
    houseRules,
    styleFingerprint,
    memoryEntries,
    symbolIndex,
    pinnedFiles,
    verifyHint,
  } = opts;

  const lines: string[] = [
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

  if (profile) {
    lines.push(
      "## Repo profile",
      "",
      renderProfileLine(profile),
      "",
    );
  }

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

  const hasOptionalSection =
    houseRulesTrimmed.length > 0 ||
    styleLines.length > 0 ||
    (memoryEntries && memoryEntries.length > 0) ||
    !!profile ||
    symbolLines.length > 0 ||
    pinnedLines.length > 0 ||
    verifyEntries.length > 0;
  if (!hasOptionalSection) return "";

  return lines.join("\n");
}

export function buildUserMessage(opts: BuildChildPromptOpts): string {
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
    bridgeFolder = BRIDGE_FOLDER,
    playbookBody,
    attachedReferences,
    recentDirection,
    detectedScope,
    sharedPlan,
  } = opts;

  const safeBody = sanitizeCoordinatorBody(coordinatorBody);
  const safeTaskBody = sanitizeTaskBodyForFence(taskBody);
  const safeTitle = sanitizeUserPromptContent(taskTitle).replace(/\r?\n/g, " ");
  const ctx = (contextBlock ?? "").trim() || "(none — bridge skipped pre-warm)";

  const lines: string[] = [
    `You are a \`${role}\` agent dispatched by the bridge coordinator for task \`${taskId}\`. You run inside \`${repo}\` (cwd resolves to \`${repoCwd}\`). You are NOT the coordinator — your job is the specific task below; you do not orchestrate, you do not spawn other agents, you produce one report and exit.`,
    "",
    "Stable per-app context (house rules, house style, memory, repo profile, available helpers, pinned files, verify commands) is in the system prompt above — read it before diving in.",
    "",
    "## Task",
    "",
    `- ID: \`${taskId}\``,
    `- Title: ${safeTitle}`,
    "- Original body (verbatim from the user):",
    "",
    "  ```",
    safeTaskBody,
    "  ```",
    "",
  ];

  if (detectedScope) {
    lines.push(
      renderDetectedScope(detectedScope, { forCoordinator: false }),
    );
  }

  const sharedPlanTrimmed = sanitizeTaskBodyForFence(
    sanitizeUserPromptContent((sharedPlan ?? "").trim()),
  );
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

  const peerNotesTrimmed = sanitizeTaskBodyForFence(
    sanitizeUserPromptContent((opts.peerNotes ?? "").trim()),
  );
  if (peerNotesTrimmed.length > 0) {
    lines.push(
      "## Peer notes (from sibling agents)",
      "",
      "Other agents on this task have already left cross-cutting observations in `sessions/" + taskId + "/notes.md`. Read them before diving in — they may answer a question you're about to ask the codebase, flag a contract another sibling already chose, or warn you about a footgun. Append your OWN observations (one bullet per entry, prefixed with your role label) when you discover something a later sibling would benefit from. Don't edit or delete prior entries — append-only.",
      "",
      peerNotesTrimmed,
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
    ...renderVerdictFileLines(opts.verdictFileName, taskId, bridgeFolder),
    "## Report contract — REQUIRED",
    "",
    "**If ambiguous, escalate.** Don't guess past a multi-option choice or approval gate. Stop, set verdict `NEEDS-DECISION`, fill `## Questions for the user` (concrete options + recommendation), exit. Guessing wastes a retry slot.",
    "",
    `Before exit, write \`../${bridgeFolder}/sessions/${taskId}/reports/${role}-${repo}.md\` (\`mkdir -p\` first). Schema (headers parsed verbatim — adding is OK, renaming/removing is NOT):`,
    "",
    "```markdown",
    `# ${role} @ ${repo}`,
    "## Verdict",
    "DONE | BLOCKED | PARTIAL | NEEDS-DECISION  (one line)",
    "  · BLOCKED → next section MUST start `BLOCK: <reason>` (auto-retry reads it)",
    "  · NEEDS-DECISION → fill `## Questions for the user`; `## Changed files` / `## How to verify` = `(none — awaiting decision)`",
    "## Summary",
    "2–4 sentences, user's language, what shipped end-to-end. No raw logs.",
    "## Questions for the user",
    "(omit / `(none)` unless NEEDS-DECISION). Per question:",
    "- **Q1:** one-sentence question. Context: 1–2 lines. Options: `(a) … (b) … (c) …`. Recommendation: which + why.",
    "## Changed files",
    "- `<path>` — one-line description. (`(none — analysis only)` for read-only runs.)",
    "## How to verify",
    "1–3 bullets: curl / test command / screen to open.",
    "## Risks / out-of-scope",
    "- bullet list, or `(none)` for either.",
    "## Notes for the coordinator",
    "Cross-repo deps (`NEEDS-OTHER-SIDE: <thing>`), hidden gotchas, follow-up tasks. If NEEDS-DECISION, flag the most blocking question.",
    "```",
    "",
    "**Peer notes (cross-cutting observations for siblings):** if during your work you discover something a SIBLING agent on the same task would benefit from — a contract you chose, a footgun you hit, a file the task body didn't mention — append ONE bullet to `sessions/<task-id>/notes.md` (create the file if absent, never edit prior entries). Format: `- [<your-role>] <observation>`. Examples worth recording: \"API uses field `userId` not `user_id`, plan said the latter\", \"refunds page is in `apps/center/finance/refunds/` not `apps/lms/`\". Skip this when there's nothing genuinely cross-cutting — noise hurts later siblings more than silence does.",
    "",
    "**End-of-turn:** (1) write the report file; (2) optionally append a peer note; (3) chat reply mirrors `## Summary`; (4) stop — no tool calls, no link re-POST, no status PATCH. Trailing tool calls render as noise; the lifecycle hook closes the run.",
    "",
    "**Git is bridge-managed.** Do NOT run `git checkout` / `commit` / `push`. The bridge prepped the branch and will auto-commit/push on clean exit per app config. Duplicating races the lifecycle hook.",
    "",
    "## Spawn-time signals",
    "",
    `- Bridge heuristic suggested target repo: \`${repo}\` (this is you).`,
    `- Parent coordinator session: \`${parentSessionId}\` — for cross-referencing in your report.`,
    "",
  );

  return lines.join("\n");
}

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

const SYMBOLS_PROMPT_CAP = 30;
function renderSymbolIndexLines(
  index: SymbolIndex | null | undefined,
): string[] {
  if (!index || !index.symbols || index.symbols.length === 0) return [];

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
  void (null as unknown as SymbolEntry | null);
  return out;
}

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
