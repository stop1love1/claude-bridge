/**
 * Shared accessor for the original prompt fed to a child agent.
 *
 * The agents POST route writes each rendered child prompt to
 * `sessions/<task>/<role>-<repo>.prompt.txt` so retry paths can
 * recompose the prompt without rerunning the coordinator. Three
 * different retry surfaces need to read this file:
 *
 *   - `lib/childRetry.ts` (crash retry — `-retry` suffix)
 *   - `lib/verifyChain.ts` (verify-fail retry — `-vretry` suffix)
 *   - `lib/verifier.ts` (claim-vs-diff retry — `-cretry` suffix)
 *
 * Extracted here so a future change to the prompt-file naming
 * convention is a single-file edit instead of three. Fail-soft to ""
 * — every caller treats an empty original as "use only the failure
 * context to make forward progress".
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { SESSIONS_DIR } from "./paths";
import type { Run } from "./meta";

/**
 * Load the most recent `<role>-<anything>.prompt.txt` written under
 * `sessions/<taskId>/`. Returns "" when:
 *   - the task dir is missing (`createTask` failure window)
 *   - no matching file exists (CLI fallback path skipped the write)
 *   - read fails (permission / disk error)
 *
 * Newest-wins because the coordinator may rewrite the same role across
 * attempts (e.g. dispatching `coder` twice with different briefs); the
 * latest brief is the correct one to recompose against.
 */
export function readOriginalPrompt(taskId: string, failedRun: Run): string {
  try {
    const dir = join(SESSIONS_DIR, taskId);
    if (!existsSync(dir)) return "";
    const candidates = readdirSync(dir).filter(
      (f) =>
        f.endsWith(".prompt.txt") &&
        f.startsWith(`${failedRun.role}-`),
    );
    candidates.sort(
      (a, b) =>
        statSync(join(dir, b)).mtimeMs - statSync(join(dir, a)).mtimeMs,
    );
    const pick = candidates[0];
    if (!pick) return "";
    return readFileSync(join(dir, pick), "utf8");
  } catch {
    return "";
  }
}
