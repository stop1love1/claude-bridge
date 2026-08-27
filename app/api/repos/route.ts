import { NextResponse } from "next/server";
import { existsSync, readdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { loadApps } from "@/libs/apps";
import { BRIDGE_ROOT } from "@/libs/paths";
import { readGitBranch } from "@/libs/git";

export const dynamic = "force-dynamic";

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
  } catch { }
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
