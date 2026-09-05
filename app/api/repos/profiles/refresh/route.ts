import { NextResponse, type NextRequest } from "next/server";
import { existsSync } from "node:fs";
import { resolveRepos } from "@/libs/repos";
import { BRIDGE_ROOT, readBridgeMd } from "@/libs/paths";
import {
  refreshAllEnriched,
  refreshOneEnriched,
  type RepoLike,
} from "@/libs/profileStore";
import { isValidAppName } from "@/libs/apps";
import { badRequest } from "@/libs/validate";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  let body: { repo?: string } = {};
  try {
    body = (await req.json()) as { repo?: string };
  } catch {
  }

  const md = readBridgeMd();
  const declared = resolveRepos(md, BRIDGE_ROOT);
  const repos: RepoLike[] = declared.map((r) => ({
    name: r.name,
    path: r.path,
    exists: existsSync(r.path),
  }));

  if (body.repo !== undefined && body.repo !== null && body.repo !== "") {
    if (!isValidAppName(body.repo)) return badRequest("invalid repo");
    const target = repos.find((r) => r.name === body.repo);
    if (!target) {
      return NextResponse.json(
        { error: `unknown repo: ${body.repo}` },
        { status: 400 },
      );
    }
    const store = await refreshOneEnriched(target);
    return NextResponse.json(store);
  }

  const store = await refreshAllEnriched(repos);
  return NextResponse.json(store);
}
