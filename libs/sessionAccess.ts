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
