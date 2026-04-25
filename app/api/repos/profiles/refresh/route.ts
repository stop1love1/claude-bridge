import { NextResponse, type NextRequest } from "next/server";
import { existsSync, readFileSync } from "node:fs";
import { resolveRepos } from "@/lib/repos";
import { BRIDGE_MD, BRIDGE_ROOT } from "@/lib/paths";
import { refreshAll, refreshOne, type RepoLike } from "@/lib/profileStore";

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

  const md = readFileSync(BRIDGE_MD, "utf8");
  const declared = resolveRepos(md, BRIDGE_ROOT);
  const repos: RepoLike[] = declared.map((r) => ({
    name: r.name,
    path: r.path,
    exists: existsSync(r.path),
  }));

  if (body.repo && typeof body.repo === "string") {
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
