import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { BRIDGE_STATE_DIR, HOOKS_DIR, SESSIONS_DIR } from "./paths";

export function buildPermissionSettings(): Record<string, unknown> {
  const hookScript = join(HOOKS_DIR, "permission-hook.cjs");
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

export function writeSessionSettings(file: string): string {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(buildPermissionSettings(), null, 2) + "\n");
  return file;
}

export function freeSessionSettingsPath(sessionId: string): string {
  return join(BRIDGE_STATE_DIR, sessionId, "settings.json");
}

export function taskSessionSettingsPath(taskId: string, sessionId: string): string {
  return join(SESSIONS_DIR, taskId, `${sessionId}.settings.json`);
}

export function cleanupSessionSettings(sessionId: string): void {
  const freeDir = join(BRIDGE_STATE_DIR, sessionId);
  try {
    rmSync(freeDir, { recursive: true, force: true, maxRetries: 2 });
  } catch {
  }
}
