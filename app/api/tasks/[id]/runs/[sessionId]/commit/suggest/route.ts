import { NextResponse, type NextRequest } from "next/server";
import { join } from "node:path";
import { getApp } from "@/libs/apps";
import { readMeta } from "@/libs/meta";
import { SESSIONS_DIR } from "@/libs/paths";
import { isValidTaskId } from "@/libs/tasks";
import { badRequest, isValidSessionId } from "@/libs/validate";
import { safeErrorMessage } from "@/libs/errorResponse";
import { generateCommitMessageWithLLM } from "@/libs/commitMessage";
import { buildHeuristicMessage, collectChanges } from "@/libs/commitHeuristic";
import { withInFlight } from "@/libs/inFlight";
import { resolveRunCwd } from "@/libs/runWorkingTree";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string; sessionId: string }> };

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
  const cwd = resolveRunCwd(run, app);
  if (!cwd) {
    return NextResponse.json(
      { error: "cannot resolve a working tree for this run" },
      { status: 404 },
    );
  }

  const wantHeuristic = req.nextUrl.searchParams.get("heuristic") === "1";

  try {
    const { rows, nameStatus, diff, diffTruncated } = await collectChanges(cwd);

    if (rows.length === 0) {
      return NextResponse.json({ message: "chore: no changes", fileCount: 0, cwd, source: "heuristic" });
    }

    if (!wantHeuristic) {
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
