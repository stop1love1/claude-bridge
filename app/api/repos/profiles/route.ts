import { NextResponse } from "next/server";
import { existsSync } from "node:fs";
import { resolveRepos } from "@/libs/repos";
import { BRIDGE_ROOT, readBridgeMd } from "@/libs/paths";
import { ensureFreshOrAuto, type RepoLike } from "@/libs/profileStore";

export const dynamic = "force-dynamic";

/**
 * GET /api/repos/profiles
 *
 * Returns the cached `ProfileStore`, auto-building on the first hit (or
 * when the cache is older than the TTL). Used by the bridge UI / by
 * coordinator-prompt rendering paths that want a synchronous read.
 */
export function GET() {
  const md = readBridgeMd();
  const declared = resolveRepos(md, BRIDGE_ROOT);
  const repos: RepoLike[] = declared.map((r) => ({
    name: r.name,
    path: r.path,
    exists: existsSync(r.path),
  }));
  const store = ensureFreshOrAuto(repos);
  return NextResponse.json(store);
}
