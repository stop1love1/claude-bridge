/**
 * Build the message body the bridge hands to `claude --resume <sid>`
 * when the coordinator opts into the `mode: "resume"` dispatch path.
 *
 * Why a dedicated builder (vs. reusing `buildChildPrompt`):
 *
 * The original spawn writes a ~5 KB preamble — language directive, full
 * task body, repo profile, available helpers, pinned files, recent
 * direction, report contract, self-register snippet — into the child's
 * very first user message. Claude persists that whole prompt in the
 * session's `.jsonl`, so on a `--resume` turn the model already has all
 * of it in its conversation context. Re-emitting any of it would burn
 * tokens for zero gain (worse: the child gets a contradictory second
 * "task body" that doesn't match the first).
 *
 * What this function emits instead, in order:
 *   1. A header line tagging the turn as a follow-up and naming the
 *      task / role / repo (so the model anchors before reading the
 *      brief).
 *   2. The coordinator session id, when present, for cross-referencing
 *      in the report.
 *   3. An explicit "your prior context is in the transcript — don't
 *      re-read or re-emit it" reminder, because Claude's default
 *      instinct on a new user turn is sometimes to recap.
 *   4. The operator's role-specific brief verbatim (sanitized for
 *      empty-string).
 *   5. The same end-of-turn order the spawn path enforces — write the
 *      report, send the chat reply, stop. Critically, the explicit
 *      "do NOT re-POST status:done" rule, because the lifecycle hook
 *      handles that on clean exit and any self-POST races the user's
 *      visible UI badge.
 *   6. A reminder that git is bridge-managed.
 *
 * Token-cost target: under ~1.5 KB of overhead on top of whatever the
 * coordinator wrote, vs. ~5 KB+ for a fresh spawn — that's the savings
 * premise the whole resume mode rests on.
 *
 * Pure function — no I/O, no env reads. Tested by
 * `lib/__tests__/agentsResume.test.ts`.
 */
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
