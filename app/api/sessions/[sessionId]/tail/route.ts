import { NextResponse, type NextRequest } from "next/server";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { projectDirFor, tailJsonl, tailJsonlBefore } from "@/libs/sessions";
import { badRequest, isValidSessionId } from "@/libs/validate";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ sessionId: string }> };

export async function GET(req: NextRequest, ctx: Ctx) {
  const { sessionId } = await ctx.params;
  if (!isValidSessionId(sessionId)) return badRequest("invalid sessionId");
  const { searchParams } = new URL(req.url);
  const repoPath = searchParams.get("repo");
  const sinceParam = searchParams.get("since");
  const beforeParam = searchParams.get("before");

  if (!repoPath) {
    return NextResponse.json({ error: "repo query param required" }, { status: 400 });
  }
  const file = join(projectDirFor(repoPath), `${sessionId}.jsonl`);

  // Backward-paging mode: caller wants the slice ENDING at `before` bytes.
  if (beforeParam !== null) {
    const before = Number(beforeParam);
    if (!existsSync(file)) {
      return NextResponse.json({ lines: [], fromOffset: 0, beforeOffset: before, lineOffsets: [] });
    }
    const result = await tailJsonlBefore(file, before);
    return NextResponse.json(result);
  }

  // Default forward-tail mode.
  const since = Number(sinceParam ?? 0);
  if (!existsSync(file)) return NextResponse.json({ lines: [], offset: since, lineOffsets: [] });
  const result = await tailJsonl(file, since);
  return NextResponse.json(result);
}
