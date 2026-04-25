import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { BRIDGE_STATE_DIR, HOOKS_DIR, SESSIONS_DIR } from "./paths";

/**
 * Build the JSON shape claude expects from `--settings`. We register a
 * single `PreToolUse` hook that matches every tool (`.*`) and shells
 * out to our standalone Node script.
 *
 * Schema source: claude-code/plugins/plugin-dev/skills/hook-development.
 * `matcher` is a regex on the tool name, `command` is run via the
 * platform shell, JSON tool context is fed on stdin, and the script
 * writes its decision back to stdout (`hookSpecificOutput.permissionDecision`).
 */
export function buildPermissionSettings(): Record<string, unknown> {
  const hookScript = join(HOOKS_DIR, "permission-hook.cjs");
  // Quote the path so spaces in the install location don't break the
  // shell argv (claude runs the command via the system shell). On
  // Windows the path will contain backslashes; bash on the same box
  // handles them in quoted form, and Node treats them transparently.
  const command = `node "${hookScript}"`;
  return {
    hooks: {
      PreToolUse: [
        {
          matcher: ".*",
          hooks: [
            { type: "command", command, timeout: 360 },
          ],
        },
      ],
    },
  };
}

/**
 * Write a per-session settings file and return its absolute path. Used
 * by both the free-session path and the resume path so the same
 * `--settings <path>` arg can be passed every time.
 */
export function writeSessionSettings(file: string): string {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(buildPermissionSettings(), null, 2) + "\n");
  return file;
}

/**
 * Settings path for a free (non-task) session. Lives under
 * `.bridge-state/<sessionId>/settings.json` — distinct from `.uploads/`
 * which holds user-uploaded chat attachments.
 */
export function freeSessionSettingsPath(sessionId: string): string {
  return join(BRIDGE_STATE_DIR, sessionId, "settings.json");
}

/** Settings path for a task-scoped session. */
export function taskSessionSettingsPath(taskId: string, sessionId: string): string {
  return join(SESSIONS_DIR, taskId, `${sessionId}.settings.json`);
}
