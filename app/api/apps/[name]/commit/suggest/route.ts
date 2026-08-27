import { NextResponse, type NextRequest } from "next/server";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { resolveAppFromRouteSegment } from "@/libs/apps";
import { safeErrorMessage } from "@/libs/errorResponse";
import { generateCommitMessageWithLLM } from "@/libs/commitMessage";
import { buildHeuristicMessage, collectChanges } from "@/libs/commitHeuristic";
import { withInFlight } from "@/libs/inFlight";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ name: string }> };

export async function POST(req: NextRequest, ctx: Ctx) {
  const { name: segment } = await ctx.params;
  const app = resolveAppFromRouteSegment(segment);
  if (!app) return NextResponse.json({ error: "app not found" }, { status: 404 });
  const cwd = app.path;
  if (!existsSync(cwd) || !existsSync(join(cwd, ".git"))) {
    return NextResponse.json({ error: "not a git repo", cwd }, { status: 404 });
  }

  const wantHeuristic = req.nextUrl.searchParams.get("heuristic") === "1";

  try {
    const { rows, nameStatus, diff, diffTruncated } = await collectChanges(cwd);

    if (rows.length === 0) {
      return NextResponse.json({ message: "chore: no changes", fileCount: 0, cwd, source: "heuristic" });
    }

    if (!wantHeuristic) {
      const llm = await withInFlight("commit-suggest", cwd, () =>
        generateCommitMessageWithLLM({ cwd, nameStatus, diff, diffTruncated }),
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
      { error: "git diff failed", detail: safeErrorMessage(err, "unknown"), cwd },
      { status: 500 },
    );
  }
}
