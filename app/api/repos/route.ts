import { NextResponse } from "next/server";
import { existsSync, readdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { loadApps } from "@/libs/apps";
import { BRIDGE_ROOT } from "@/libs/paths";
import { readGitBranch } from "@/libs/git";

export const dynamic = "force-dynamic";

/**
 * Returns every repo the user might want to drop a session into:
 *
 * - **registered**: rows from `sessions/init.md` (the apps registry,
 *   editable via `POST /api/apps`). Each entry is the app's name + the
 *   resolved cwd, plus the existing-on-disk flag.
 * - **bridge**:    this bridge folder itself.
 * - **discovered**: any other directory living next to the bridge in
 *   the parent folder. The user often has more projects than they
 *   bother registering, so we surface those automatically — they show
 *   up in the dropdown but disappear once the user clicks "Add app"
 *   to register them.
 *
 * Each entry includes the currently checked-out git branch (if the
 * folder is a working tree). Hidden / dot directories are skipped.
 */
export function GET() {
  const registered = loadApps();
  const registeredNames = new Set(registered.map((a) => a.name));

  const parent = dirname(BRIDGE_ROOT);
  const bridgeName = basename(BRIDGE_ROOT);
  const discovered: Array<{ name: string; path: string }> = [];
  try {
    for (const entry of readdirSync(parent, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith(".")) continue;
      if (entry.name === bridgeName) continue;
      if (registeredNames.has(entry.name)) continue;
      discovered.push({ name: entry.name, path: join(parent, entry.name) });
    }
  } catch { /* parent unreadable — ignore */ }
  discovered.sort((a, b) => a.name.localeCompare(b.name));

  return NextResponse.json([
    ...registered.map((a) => ({
      name: a.name,
      path: a.path,
      exists: existsSync(a.path),
      declared: true as const,
      description: a.description,
      branch: existsSync(a.path) ? readGitBranch(a.path) : null,
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
