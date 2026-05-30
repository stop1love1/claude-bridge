import { NextResponse, type NextRequest } from "next/server";
import { join } from "node:path";
import { BRIDGE_ROOT, SESSIONS_DIR, readBridgeMd } from "@/libs/paths";
import { reapStaleRunsForDir } from "@/libs/staleRunReaper";
import { getApp } from "@/libs/apps";
import { resolveRepoCwd } from "@/libs/repos";
import { isValidTaskId } from "@/libs/tasks";
import { badRequest } from "@/libs/validate";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/**
 * Resolve a run's `repo` (app name) to its absolute path. The operator UI
 * derives this from the repos list it already fetches, but a task-share
 * guest can't list repos — so we surface `repoPath` per run here. It's
 * the value SessionLog needs to open the tail stream. Cached per request.
 */
function repoPathResolver(): (repo: string) => string | null {
  const cache = new Map<string, string | null>();
  let md: string | null | undefined;
  return (repo: string) => {
    if (cache.has(repo)) return cache.get(repo) ?? null;
    let path = getApp(repo)?.path ?? null;
    if (!path) {
      if (md === undefined) md = readBridgeMd();
      if (md) path = resolveRepoCwd(md, BRIDGE_ROOT, repo) ?? null;
    }
    cache.set(repo, path);
    return path;
  };
}

export async function GET(_req: NextRequest, ctx: Ctx) {
  const { id } = await ctx.params;
  if (!isValidTaskId(id)) return badRequest("invalid task id");
  const meta = await reapStaleRunsForDir(join(SESSIONS_DIR, id));
  if (!meta) return NextResponse.json({ error: "not found" }, { status: 404 });
  // Enrich each run with its resolved absolute repoPath so any consumer
  // (operator UI or guest share view) can open the session tail stream
  // without separately resolving the app registry. Extra field; existing
  // consumers ignore it.
  const resolve = repoPathResolver();
  const enriched = {
    ...meta,
    runs: meta.runs.map((r) => ({ ...r, repoPath: resolve(r.repo) })),
  };
  return NextResponse.json(enriched);
}
