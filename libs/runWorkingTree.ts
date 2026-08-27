import { existsSync } from "node:fs";
import { resolve, sep } from "node:path";
import type { App } from "./apps";
import type { Run } from "./meta";
import { resolveRepoCwd } from "./repos";
import { BRIDGE_ROOT, readBridgeMd } from "./paths";

export function isUnderAppRoot(appPath: string, candidate: string): boolean {
  const a = resolve(appPath);
  const c = resolve(candidate);
  if (a === c) return true;
  return c.startsWith(a + sep) || c.startsWith(a + "/");
}

export function resolveRunCwd(run: Run, app: App | null): string | null {
  let cwd: string | null = null;
  if (
    run.worktreePath &&
    app &&
    isUnderAppRoot(app.path, run.worktreePath) &&
    existsSync(run.worktreePath)
  ) {
    cwd = run.worktreePath;
  } else if (app && existsSync(app.path)) {
    cwd = app.path;
  } else {
    const md = readBridgeMd();
    if (md) {
      const resolved = resolveRepoCwd(md, BRIDGE_ROOT, run.repo);
      if (resolved && existsSync(resolved)) cwd = resolved;
    }
  }
  return cwd;
}
