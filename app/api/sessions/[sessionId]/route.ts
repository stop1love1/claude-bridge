import { NextResponse, type NextRequest } from "next/server";
import { existsSync, readdirSync, rmSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { resolveRepos } from "@/libs/repos";
import { discoverOrphanProjects, projectDirFor } from "@/libs/sessions";
import { findSessionTaskDirs, removeSessionFromTask } from "@/libs/meta";
import { BRIDGE_ROOT, readBridgeMd } from "@/libs/paths";
import { bustSessionsListCache } from "@/libs/sessionListCache";
import { badRequest, isValidSessionId } from "@/libs/validate";
import { safeErrorMessage } from "@/libs/errorResponse";
import { ok } from "@/libs/apiResponse";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ sessionId: string }> };

export async function DELETE(req: NextRequest, ctx: Ctx) {
  const { sessionId } = await ctx.params;
  if (!isValidSessionId(sessionId)) return badRequest("invalid sessionId");

  const { searchParams } = new URL(req.url);
  const repoHint = searchParams.get("repo");

  const md = readBridgeMd();
  const declared = [
    { name: basename(BRIDGE_ROOT), path: BRIDGE_ROOT },
    ...resolveRepos(md, BRIDGE_ROOT).map((r) => ({ name: r.name, path: r.path })),
  ];

  const parent = dirname(BRIDGE_ROOT);
  const seenNames = new Set(declared.map((r) => r.name));
  const seenProjectDirs = new Set(declared.map((r) => projectDirFor(r.path)));
  const discovered: Array<{ name: string; path: string }> = [];
  try {
    for (const entry of readdirSync(parent, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith(".")) continue;
      if (seenNames.has(entry.name)) continue;
      const path = join(parent, entry.name);
      discovered.push({ name: entry.name, path });
      seenNames.add(entry.name);
      seenProjectDirs.add(projectDirFor(path));
    }
  } catch { }

  for (const orphan of discoverOrphanProjects(seenProjectDirs)) {
    if (seenNames.has(orphan.name)) continue;
    discovered.push({ name: orphan.name, path: orphan.path });
    seenNames.add(orphan.name);
  }

  const allCandidates = [...declared, ...discovered];
  const targets = repoHint
    ? allCandidates.filter((r) => r.name === repoHint)
    : allCandidates;
  if (targets.length === 0) {
    return NextResponse.json({ error: `unknown repo: ${repoHint}` }, { status: 400 });
  }

  let removedFile: string | null = null;
  for (const r of targets) {
    const candidate = join(projectDirFor(r.path), `${sessionId}.jsonl`);
    if (existsSync(candidate)) {
      try {
        rmSync(candidate, { force: true });
        removedFile = candidate;
        break;
      } catch (e) {
        return NextResponse.json({ error: `delete failed: ${safeErrorMessage(e)}` }, { status: 500 });
      }
    }
  }

  const unlinkedFromTasks: string[] = [];
  for (const dir of findSessionTaskDirs(sessionId)) {
    const removed = await removeSessionFromTask(dir, sessionId);
    if (removed) unlinkedFromTasks.push(basename(dir));
  }

  if (!removedFile && unlinkedFromTasks.length === 0) {
    return NextResponse.json({ error: "session not found" }, { status: 404 });
  }
  bustSessionsListCache();
  return ok({
    fileRemoved: removedFile,
    unlinkedFromTasks,
  });
}
