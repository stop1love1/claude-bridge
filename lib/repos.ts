import { existsSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { loadApps, type App } from "./apps";

export interface RepoEntry { name: string }
export interface ResolvedRepo extends RepoEntry { path: string }

/**
 * Apps registry now lives in `sessions/init.md`, owned by `lib/apps.ts`.
 * `parseReposTable` / `resolveRepos` remain as a thin wrapper so the
 * existing call sites (coordinator, profile loader, route handlers) keep
 * working without scattering `loadApps()` everywhere.
 *
 * BRIDGE.md is no longer parsed for the apps roster — it stays as a
 * pure human-readable notebook for cross-repo decisions / contracts.
 */

function appsAsRepos(): ResolvedRepo[] {
  return loadApps().map((app: App) => ({ name: app.name, path: app.path }));
}

/**
 * Kept for API compatibility. The `bridgeMd` argument is ignored; the
 * apps registry is now `sessions/init.md`. Tests still pass a fixture
 * string to assert legacy behaviour — they should migrate to seeding
 * `sessions/init.md` directly.
 */
export function parseReposTable(_bridgeMd: string): RepoEntry[] {
  return loadApps().map((app) => ({ name: app.name }));
}

export function resolveRepos(_bridgeMd: string, _bridgeRoot: string): ResolvedRepo[] {
  return appsAsRepos();
}

/**
 * Resolve a repo *name* to an absolute cwd. Tries, in order:
 *   1. the bridge folder itself (so `repo: "<bridge-folder>"` keeps working)
 *   2. anything declared in the apps registry (sessions/init.md)
 *   3. any sibling folder that exists next to the bridge
 *
 * Returns `null` if no match — the caller should reject the request.
 *
 * `bridgeMd` is accepted (ignored) for backwards compatibility — every
 * caller still threads it through, but the registry is no longer there.
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
