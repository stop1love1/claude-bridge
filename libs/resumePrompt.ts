export function buildResumePrompt(opts: {
  taskId: string;
  role: string;
  repo: string;
  parentSessionId: string | null;
  coordinatorBody: string;
}): string {
  const { taskId, role, repo, parentSessionId, coordinatorBody } = opts;
  const trimmed = (coordinatorBody ?? "").trim();
  const safeBody = trimmed.length > 0
    ? trimmed
    : "(coordinator did not provide a follow-up brief)";
  return [
    `**Follow-up turn — task \`${taskId}\`, role \`${role}\` @ \`${repo}\`.**`,
    "",
    parentSessionId
      ? `Coordinator session: \`${parentSessionId}\`.`
      : "Coordinator session: (none — direct spawn).",
    "",
    "Your prior context (task body, repo profile, helpers, report contract, self-register snippet) is already in this session's transcript — do NOT re-read or re-emit it. Just act on the brief below.",
    "",
    "---",
    "",
    safeBody,
    "",
    "---",
    "",
    "**End-of-turn order (same as the original spawn):**",
    `1. Update or append to \`sessions/${taskId}/reports/${role}-${repo}.md\` with this turn's findings.`,
    "2. Send your final assistant message mirroring the new `## Summary`.",
    "3. Stop. Do not re-POST `status:\"done\"` — the bridge's lifecycle hook flips your run from running → done on clean exit. The only legitimate self-POST is `status:\"failed\"` if you abort early.",
    "",
    "Git is still bridge-managed: do not run `git checkout` / `commit` / `push` — auto-commit fires after you exit cleanly.",
  ].join("\n");
}
