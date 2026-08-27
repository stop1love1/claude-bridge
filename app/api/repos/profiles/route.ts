import { NextResponse } from "next/server";
import { existsSync } from "node:fs";
import { resolveRepos } from "@/libs/repos";
import { BRIDGE_ROOT, readBridgeMd } from "@/libs/paths";
import { ensureFreshOrAuto, type RepoLike } from "@/libs/profileStore";

export const dynamic = "force-dynamic";

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
