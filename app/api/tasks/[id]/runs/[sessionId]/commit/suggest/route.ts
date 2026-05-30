/**
 * Commit-message suggester for a single run's worktree.
 *
 * Resolves the run's working tree (worktree if still on disk, else the
 * live app tree), then tries the LLM generator first — claude reads the
 * actual diff (embedded in the prompt) and writes a Conventional Commits
 * message with body — and falls back to the local heuristic when the LLM
 * is disabled / times out / fails.
 *
 * Change collection + the heuristic generator live in
 * `libs/commitHeuristic.ts` (shared with the app-scoped suggest route).
 */
import { NextResponse, type NextRequest } from "next/server";
import { existsSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { getApp } from "@/libs/apps";
import { readMeta } from "@/libs/meta";
import { resolveRepoCwd } from "@/libs/repos";
import { BRIDGE_ROOT, SESSIONS_DIR, readBridgeMd } from "@/libs/paths";
import { isValidTaskId } from "@/libs/tasks";
import { badRequest, isValidSessionId } from "@/libs/validate";
import { safeErrorMessage } from "@/libs/errorResponse";
import { generateCommitMessageWithLLM } from "@/libs/commitMessage";
import { buildHeuristicMessage, collectChanges } from "@/libs/commitHeuristic";
import { withInFlight } from "@/libs/inFlight";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string; sessionId: string }> };

function isUnderAppRoot(appPath: string, candidate: string): boolean {
  const a = resolve(appPath);
  const c = resolve(candidate);
  if (a === c) return true;
  return c.startsWith(a + sep) || c.startsWith(a + "/");
}

export async function POST(req: NextRequest, ctx: Ctx) {
  const { id, sessionId } = await ctx.params;
  if (!isValidTaskId(id)) return badRequest("invalid task id");
  if (!isValidSessionId(sessionId)) return badRequest("invalid sessionId");

  const dir = join(SESSIONS_DIR, id);
  const meta = readMeta(dir);
  if (!meta) {
    return NextResponse.json({ error: "task not found" }, { status: 404 });
  }
  const run = meta.runs.find((r) => r.sessionId === sessionId);
  if (!run) {
    return NextResponse.json({ error: "run not found" }, { status: 404 });
  }

  const app = getApp(run.repo);
  let cwd: string | null = null;
  if (
    run.worktreePath &&
    app &&
    isUnderAppRoot(app.path, run.worktreePath) &&
    existsSync(run.worktreePath)
  ) {
    cwd = run.worktreePath;
  } else if (app && existsSync(app.path)) {
    cwd = app.path;
  } else {
    const md = readBridgeMd();
    if (md) {
      const resolved = resolveRepoCwd(md, BRIDGE_ROOT, run.repo);
      if (resolved && existsSync(resolved)) cwd = resolved;
    }
  }
  if (!cwd) {
    return NextResponse.json(
      { error: "cannot resolve a working tree for this run" },
      { status: 404 },
    );
  }

  // `?heuristic=1` → skip the LLM entirely (UI toggle / tests).
  const wantHeuristic = req.nextUrl.searchParams.get("heuristic") === "1";

  try {
    const { rows, nameStatus, diff, diffTruncated } = await collectChanges(cwd);

    if (rows.length === 0) {
      return NextResponse.json({ message: "chore: no changes", fileCount: 0, cwd, source: "heuristic" });
    }

    // Try LLM first (unless explicitly disabled). Pass the task title for
    // "what was supposed to ship" context plus the embedded diff so the
    // model grounds the subject in the actual change, in one pass.
    if (!wantHeuristic) {
      // Dedupe concurrent generations for the same tree so two button
      // clicks / tabs never spawn two `claude -p` children at once.
      const llm = await withInFlight("commit-suggest", cwd, () =>
        generateCommitMessageWithLLM({
          cwd,
          taskTitle: meta.taskTitle,
          nameStatus,
          diff,
          diffTruncated,
        }),
      );
      if (llm) {
        return NextResponse.json({ message: llm.message, fileCount: rows.length, cwd, source: "llm" });
      }
    }

    return NextResponse.json({
      message: buildHeuristicMessage(rows),
      fileCount: rows.length,
      cwd,
      source: "heuristic",
    });
  } catch (err) {
    return NextResponse.json(
      { error: "git diff failed", detail: safeErrorMessage(err, "unknown") },
      { status: 500 },
    );
  }
}
