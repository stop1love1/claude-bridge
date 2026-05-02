import { NextResponse, type NextRequest } from "next/server";
import { existsSync, readdirSync, rmSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { resolveRepos } from "@/libs/repos";
import { discoverOrphanProjects, projectDirFor } from "@/libs/sessions";
import { removeSessionFromTask } from "@/libs/meta";
import { BRIDGE_ROOT, SESSIONS_DIR, readBridgeMd } from "@/libs/paths";
import { bustSessionsListCache } from "@/libs/sessionListCache";
import { badRequest, isValidSessionId } from "@/libs/validate";
import { safeErrorMessage } from "@/libs/errorResponse";
import { ok } from "@/libs/apiResponse";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ sessionId: string }> };

/**
 * Delete a Claude Code session: removes the .jsonl from
 * `~/.claude/projects/<slug>/` and unlinks the session from any task's
 * meta.json. Runtime task state lives in `meta.json`, so the task row
 * itself is unaffected — only the linked session goes.
 *
 * The repo is required because the same sessionId could theoretically
 * collide across project dirs; we won't guess.
 *
 *   DELETE /api/sessions/<sessionId>?repo=<folder-name>
 *   DELETE /api/sessions/<sessionId>          → search every known repo
 */
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

  // Bring in sibling folders too — discovered repos can also host sessions.
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
  } catch { /* ignore */ }

  // Mirror /api/sessions/all: surface every project folder under
  // ~/.claude/projects/ that holds at least one session, even if it's
  // not a registered repo or current sibling. Without this, sessions
  // recovered via cwd from .jsonl files (worktrees, since-deleted
  // siblings, unrelated cwds) would 404 on DELETE because the named
  // candidate list never sees them.
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

  // Unlink from any task meta.json that references this session. We
  // use `removeSessionFromTask` so the read-filter-write happens under
  // the same per-task lock that protects appendRun/updateRun (H7) and
  // through `atomicWriteJson` rather than a raw `writeFileSync`.
  //
  // TODO: O(N) scan over every task dir on every delete. A reverse
  // index (sessionId → taskId) — see `buildLinkIndex` in
  // app/api/sessions/all/route.ts — could turn this into a single
  // lookup. Punted: factoring that helper into `libs/meta.ts` is wider
  // than this brief.
  const unlinkedFromTasks: string[] = [];
  if (existsSync(SESSIONS_DIR)) {
    for (const taskId of readdirSync(SESSIONS_DIR)) {
      const dir = join(SESSIONS_DIR, taskId);
      const removed = await removeSessionFromTask(dir, sessionId);
      if (removed) unlinkedFromTasks.push(taskId);
    }
  }

  if (!removedFile && unlinkedFromTasks.length === 0) {
    return NextResponse.json({ error: "session not found" }, { status: 404 });
  }
  // Drop the /api/sessions/all 2 s response cache. removeSessionFromTask
  // already emits meta:changed when a link existed, but pure orphan
  // deletes never touch meta — without an explicit bust the next poll
  // would still surface the just-deleted row for up to TTL.
  bustSessionsListCache();
  return ok({
    fileRemoved: removedFile,
    unlinkedFromTasks,
  });
}
