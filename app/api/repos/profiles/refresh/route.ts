import { NextResponse, type NextRequest } from "next/server";
import { existsSync } from "node:fs";
import { resolveRepos } from "@/lib/repos";
import { BRIDGE_ROOT, readBridgeMd } from "@/lib/paths";
import { refreshAll, refreshOne, type RepoLike } from "@/lib/profileStore";
import { isValidAppName } from "@/lib/apps";
import { badRequest } from "@/lib/validate";

export const dynamic = "force-dynamic";

/**
 * POST /api/repos/profiles/refresh
 *
 * Body: optionally `{ repo: string }` to refresh a single repo. With no
 * body (or no `repo`) refreshes every declared repo from BRIDGE.md.
 * Returns the updated store.
 */
export async function POST(req: NextRequest) {
  let body: { repo?: string } = {};
  try {
    body = (await req.json()) as { repo?: string };
  } catch {
    /* empty body is fine — refresh all */
  }

  const md = readBridgeMd();
  const declared = resolveRepos(md, BRIDGE_ROOT);
  const repos: RepoLike[] = declared.map((r) => ({
    name: r.name,
    path: r.path,
    exists: existsSync(r.path),
  }));

  if (body.repo !== undefined && body.repo !== null && body.repo !== "") {
    // M8: gate the repo name through `isValidAppName` before using it
    // as a key into the registry. Even though `find()` later catches
    // unknown names, an unbounded string here previously meant a caller
    // could probe with arbitrary payloads and shape the error response;
    // tightening to the slug charset (≤ 64 chars, `[A-Za-z0-9._-]+`)
    // matches every other entry-point in this audit pass.
    if (!isValidAppName(body.repo)) return badRequest("invalid repo");
    const target = repos.find((r) => r.name === body.repo);
    if (!target) {
      return NextResponse.json(
        { error: `unknown repo: ${body.repo}` },
        { status: 400 },
      );
    }
    const store = refreshOne(target);
    return NextResponse.json(store);
  }

  const store = refreshAll(repos);
  return NextResponse.json(store);
}
