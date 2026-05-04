/**
 * Authorization helpers shared by session-tail / session-list routes.
 *
 * `resolveSessionFile` (in `libs/sessions.ts`) gates path traversal —
 * the resolved JSONL must live under `~/.claude/projects/`. But Claude
 * Code stores sessions for EVERY project the operator has ever opened
 * with `claude`, including personal repos that aren't registered with
 * the bridge. Without this whitelist, any authenticated bridge cookie
 * can tail those non-bridge sessions.
 *
 * `isRegisteredRepoPath` returns true when the requested cwd matches a
 * registered app (apps.json) OR the bridge root itself (which hosts
 * coordinator sessions). Routes that accept a `repo` query parameter
 * should call this BEFORE handing the value to `resolveSessionFile`.
 */
import { resolve as resolvePath } from "node:path";
import { loadApps } from "./apps";
import { BRIDGE_ROOT } from "./paths";

export function isRegisteredRepoPath(repoPath: unknown): repoPath is string {
  if (typeof repoPath !== "string" || !repoPath) return false;
  const target = resolvePath(repoPath);
  if (target === resolvePath(BRIDGE_ROOT)) return true;
  for (const app of loadApps()) {
    if (resolvePath(app.path) === target) return true;
  }
  return false;
}
