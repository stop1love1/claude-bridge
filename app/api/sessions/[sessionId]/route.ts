import { NextResponse, type NextRequest } from "next/server";
import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { resolveRepos } from "@/lib/repos";
import { projectDirFor } from "@/lib/sessions";
import { removeSessionFromTask } from "@/lib/meta";
import { BRIDGE_MD, BRIDGE_ROOT, SESSIONS_DIR } from "@/lib/paths";
import { badRequest, isValidSessionId } from "@/lib/validate";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ sessionId: string }> };

/**
 * Delete a Claude Code session: removes the .jsonl from
 * `~/.claude/projects/<slug>/` and unlinks the session from any task's
 * meta.json. The bridge `tasks.md` entry stays — only the session goes.
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

  const md = readFileSync(BRIDGE_MD, "utf8");
  const declared = [
    { name: basename(BRIDGE_ROOT), path: BRIDGE_ROOT },
    ...resolveRepos(md, BRIDGE_ROOT).map((r) => ({ name: r.name, path: r.path })),
  ];

  // Bring in sibling folders too — discovered repos can also host sessions.
  const parent = dirname(BRIDGE_ROOT);
  const known = new Set(declared.map((r) => r.name));
  const discovered: Array<{ name: string; path: string }> = [];
  try {
    for (const entry of readdirSync(parent, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith(".")) continue;
      if (known.has(entry.name)) continue;
      discovered.push({ name: entry.name, path: join(parent, entry.name) });
    }
  } catch { /* ignore */ }

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
        return NextResponse.json({ error: `delete failed: ${(e as Error).message}` }, { status: 500 });
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
  // lookup. Punted: factoring that helper into `lib/meta.ts` is wider
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
  return NextResponse.json({
    ok: true,
    fileRemoved: removedFile,
    unlinkedFromTasks,
  });
}
