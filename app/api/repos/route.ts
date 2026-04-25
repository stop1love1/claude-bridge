import { NextResponse } from "next/server";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { resolveRepos } from "@/lib/repos";
import { BRIDGE_MD, BRIDGE_ROOT } from "@/lib/paths";
import { readGitBranch } from "@/lib/git";

export const dynamic = "force-dynamic";

/**
 * Returns every repo the user might want to drop a session into:
 *
 * - **declared**: rows from the BRIDGE.md Repos table (canonical roster)
 * - **bridge**:  this bridge folder itself
 * - **discovered**: any other directory living next to the bridge in the
 *   parent folder. The user often has more projects in the workspace
 *   than they bother registering in BRIDGE.md, so we surface those
 *   automatically rather than forcing edits to BRIDGE.md.
 *
 * Each entry includes the currently checked-out git branch (if the
 * folder is a working tree). Hidden / dot directories are skipped.
 */
export function GET() {
  const md = readFileSync(BRIDGE_MD, "utf8");
  const declared = resolveRepos(md, BRIDGE_ROOT);
  const declaredNames = new Set(declared.map((r) => r.name));

  const parent = dirname(BRIDGE_ROOT);
  const bridgeName = basename(BRIDGE_ROOT);
  const discovered: Array<{ name: string; path: string }> = [];
  try {
    for (const entry of readdirSync(parent, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith(".")) continue;
      if (entry.name === bridgeName) continue;
      if (declaredNames.has(entry.name)) continue;
      discovered.push({ name: entry.name, path: join(parent, entry.name) });
    }
  } catch { /* parent unreadable — ignore */ }
  discovered.sort((a, b) => a.name.localeCompare(b.name));

  return NextResponse.json([
    ...declared.map((r) => ({
      name: r.name,
      path: r.path,
      exists: existsSync(r.path),
      declared: true as const,
      branch: existsSync(r.path) ? readGitBranch(r.path) : null,
    })),
    {
      name: bridgeName,
      path: BRIDGE_ROOT,
      exists: true,
      declared: true as const,
      isBridge: true as const,
      branch: readGitBranch(BRIDGE_ROOT),
    },
    ...discovered.map((r) => ({
      name: r.name,
      path: r.path,
      exists: true,
      declared: false as const,
      branch: readGitBranch(r.path),
    })),
  ]);
}
