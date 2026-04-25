import { existsSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

export interface RepoEntry { name: string }
export interface ResolvedRepo extends RepoEntry { path: string }

/**
 * Parse BRIDGE.md Repos table. Accepts any number of repos with a minimal
 * single-column layout:
 *
 *   | Folder name |
 *   |-------------|
 *   | `app-web`   |
 *   | `app-api`   |
 *
 * Additional columns (e.g. Stack, Purpose) are ignored — only the folder
 * name cell is required. No role hardcoding; the bridge treats all
 * siblings equally and the coordinator decides which to target per task.
 */
export function parseReposTable(bridgeMd: string): RepoEntry[] {
  const section = bridgeMd.match(/##\s+Repos[\s\S]*?(?=\n##\s|\n$|$)/);
  if (!section) throw new Error("No Repos table found in BRIDGE.md");

  const entries: RepoEntry[] = [];
  const seen = new Set<string>();
  for (const line of section[0].split("\n")) {
    if (!line.startsWith("|")) continue;
    if (/^\|\s*-{2,}/.test(line)) continue;                   // separator row
    if (/\|\s*folder\s*name\s*\|/i.test(line)) continue;      // header row
    const cells = line.split("|").slice(1, -1).map((c) => c.trim());
    const folder = cells
      .map((c) => c.replace(/^`|`$/g, ""))
      .find((c) => /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(c));
    if (!folder || seen.has(folder)) continue;
    seen.add(folder);
    entries.push({ name: folder });
  }
  if (entries.length === 0) throw new Error("Repos table is empty");
  return entries;
}

export function resolveRepos(bridgeMd: string, bridgeRoot: string): ResolvedRepo[] {
  const parent = dirname(resolve(bridgeRoot));
  return parseReposTable(bridgeMd).map((e) => ({
    ...e,
    path: resolve(parent, e.name),
  }));
}

/**
 * Resolve a repo *name* to an absolute cwd. Tries, in order:
 *   1. the bridge folder itself
 *   2. anything declared in BRIDGE.md
 *   3. any sibling folder that exists next to the bridge
 *
 * Returns `null` if no match — the caller should reject the request.
 */
export function resolveRepoCwd(
  bridgeMd: string,
  bridgeRoot: string,
  name: string,
): string | null {
  if (!name || /[\\/]/.test(name)) return null;
  const root = resolve(bridgeRoot);
  if (name === basename(root)) return root;
  const declared = resolveRepos(bridgeMd, bridgeRoot).find((r) => r.name === name);
  if (declared) return declared.path;
  const sibling = join(dirname(root), name);
  if (existsSync(sibling)) return sibling;
  return null;
}
