import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { SESSIONS_DIR } from "./paths";
import type { Run } from "./meta";

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
