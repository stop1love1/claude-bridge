import { NextResponse, type NextRequest } from "next/server";
import { existsSync } from "node:fs";
import { resolveRepos } from "@/lib/repos";
import { BRIDGE_ROOT, readBridgeMd } from "@/lib/paths";
import { ensureFreshOrAuto, type RepoLike } from "@/lib/profileStore";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ name: string }> };

/**
 * GET /api/repos/profiles/<name>
 *
 * Returns a single repo profile. 404 if the repo isn't declared in
 * BRIDGE.md or its folder is missing on disk. Auto-builds the cache
 * lazily (same path as `/api/repos/profiles`).
 */
export async function GET(_req: NextRequest, ctx: Ctx) {
  const { name } = await ctx.params;
  if (!name) {
    return NextResponse.json({ error: "name required" }, { status: 400 });
  }

  const md = readBridgeMd();
  const declared = resolveRepos(md, BRIDGE_ROOT);
  const declaredEntry = declared.find((r) => r.name === name);
  if (!declaredEntry) {
    return NextResponse.json(
      { error: `unknown repo: ${name}` },
      { status: 404 },
    );
  }
  if (!existsSync(declaredEntry.path)) {
    return NextResponse.json(
      { error: `repo folder missing: ${name}` },
      { status: 404 },
    );
  }

  const repos: RepoLike[] = declared.map((r) => ({
    name: r.name,
    path: r.path,
    exists: existsSync(r.path),
  }));
  const store = ensureFreshOrAuto(repos);
  const profile = store.profiles[name];
  if (!profile) {
    return NextResponse.json(
      { error: `profile not built for: ${name}` },
      { status: 404 },
    );
  }
  return NextResponse.json(profile);
}
