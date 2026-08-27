import { basename, resolve } from "node:path";
import { loadApps, type App } from "./apps";

export interface RepoEntry { name: string }
export interface ResolvedRepo extends RepoEntry { path: string }


function appsAsRepos(): ResolvedRepo[] {
  return loadApps().map((app: App) => ({ name: app.name, path: app.path }));
}

export function parseReposTable(_bridgeMd: string): RepoEntry[] {
  return loadApps().map((app) => ({ name: app.name }));
}

export function resolveRepos(_bridgeMd: string, _bridgeRoot: string): ResolvedRepo[] {
  return appsAsRepos();
}

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
  return null;
}
