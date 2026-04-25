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
   * (P1/H1) Pre-loaded `bridge/playbooks/<role>.md` markdown. When
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
 * prompt. We replace the fence prefix with a non-terminating variant
 * (zero-width joiner) that the LLM still reads as backticks for
 * intent, but the markdown parser does not treat as a fence boundary.
 */
export function sanitizeTaskBodyForFence(body: string): string {
  return (body ?? "").replace(/^(\s*)(`{3,})/gm, "$1‍$2");
}

/**
 * Build the full child prompt. Pure function — no I/O.
 *
 * Output sections, in order (sections marked OPT-IN are emitted only
 * when the corresponding input is present):
 *   1. Header line (role, task id, repo, cwd, dispatcher disclaimer)
 *   2. ## Language
 *   3. ## House rules                            (OPT-IN — opts.houseRules)
 *   4. ## Task
 *   5. ## Your role (playbook prepended if any, then coordinator brief)
 *   6. ## Repo profile
 *   7. ## Repo context (auto-captured by bridge)
 *   8. ## Self-register
 *   9. ## Report contract — REQUIRED
 *  10. ## Verify commands                        (OPT-IN — opts.verifyHint)
 *  11. ## Spawn-time signals
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
    "## Repo context (auto-captured by bridge)",
    "",
    ctx,
    "",
    "## Self-register",
    "",
    `Your session UUID is \`${childSessionId}\` — already passed via \`--session-id\`. The bridge has pre-registered your run in \`meta.json\`. Confirm registration once via:`,
    "",
    "```bash",
    `curl -s -X POST ${BRIDGE_URL}/api/tasks/${taskId}/link \\`,
    `  -H "content-type: application/json" \\`,
    `  -d '{"sessionId":"${childSessionId}","role":"${role}","repo":"${repo}","status":"running"}'`,
    "```",
    "",
    'When done, re-POST the same body with `"status":"done"` (or `"failed"`).',
    "",
    "## Report contract — REQUIRED",
    "",
    `Before you exit, write \`../${bridgeFolder}/sessions/${taskId}/reports/${role}-${repo}.md\` (\`mkdir -p\` the dir first). Use this exact schema:`,
    "",
    "```markdown",
    `# ${role} @ ${repo}`,
    "",
    "## Verdict",
    "DONE | BLOCKED | PARTIAL — one line, no extra prose. If BLOCKED, the next section MUST start with `BLOCK: <reason>` so the bridge auto-retry path can read it.",
    "",
    "## Summary",
    "2–4 sentences in the user's language describing what shipped end-to-end. No raw logs.",
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
    "Anything the coordinator should know when aggregating: cross-repo dependencies surfaced (`NEEDS-OTHER-SIDE: <thing>`), hidden gotchas, follow-up tasks worth filing.",
    "```",
    "",
    "The coordinator parses these section headers exactly. Stick to the schema — adding sections is fine, removing or renaming is NOT.",
    "",
    "After writing the report, do NOT call any more tools. Your last assistant message should mirror the report's `## Summary` section so the user sees it in the chat too.",
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
