import { existsSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { loadApps, type App } from "./apps";

export interface RepoEntry { name: string }
export interface ResolvedRepo extends RepoEntry { path: string }

/**
 * The apps registry lives in `~/.claude/bridge.json` and is owned by
 * `lib/apps.ts`. `parseReposTable` / `resolveRepos` are thin wrappers
 * kept so existing call sites (coordinator, profile loader, route
 * handlers) don't scatter `loadApps()` everywhere.
 *
 * BRIDGE.md is no longer parsed for the apps roster — it stays a
 * human-readable notebook for cross-repo decisions / contracts. The
 * `bridgeMd` arguments below are accepted for API compatibility and
 * intentionally ignored.
 */

function appsAsRepos(): ResolvedRepo[] {
  return loadApps().map((app: App) => ({ name: app.name, path: app.path }));
}

export function parseReposTable(_bridgeMd: string): RepoEntry[] {
  return loadApps().map((app) => ({ name: app.name }));
}

export function resolveRepos(_bridgeMd: string, _bridgeRoot: string): ResolvedRepo[] {
  return appsAsRepos();
}

/**
 * Resolve a repo *name* to an absolute cwd. Tries, in order:
 *   1. the bridge folder itself (so `repo: "<bridge-folder>"` keeps working)
 *   2. anything declared in the apps registry (`~/.claude/bridge.json`)
 *   3. any sibling folder that exists next to the bridge
 *
 * Returns `null` if no match — the caller should reject the request.
 */
export function resolveRepoCwd(
  _bridgeMd: string,
  bridgeRoot: string,
  name: string,
): string | null {
  if (!name || /[\\/]/.test(name)) return null;
  const root = resolve(bridgeRoot);
  if (name === basename(root)) return root;
  const declared = appsAsRepos().find((r) => r.name === name);
  if (declared) return declared.path;
  const sibling = join(dirname(root), name);
  if (existsSync(sibling)) return sibling;
  return null;
}
