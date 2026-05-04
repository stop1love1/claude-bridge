import { NextResponse, type NextRequest } from "next/server";
import { existsSync } from "node:fs";
import { resolveSessionFile, tailJsonl, tailJsonlBefore } from "@/libs/sessions";
import { isRegisteredRepoPath } from "@/libs/sessionAccess";
import { badRequest } from "@/libs/validate";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ sessionId: string }> };

export async function GET(req: NextRequest, ctx: Ctx) {
  const { sessionId } = await ctx.params;
  const { searchParams } = new URL(req.url);
  const repoPath = searchParams.get("repo");
  const sinceParam = searchParams.get("since");
  const beforeParam = searchParams.get("before");

  // Whitelist repo against registered apps before hitting the file resolver.
  if (!isRegisteredRepoPath(repoPath)) return badRequest("invalid session repo");
  const file = resolveSessionFile(repoPath, sessionId);
  if (!file) return badRequest("invalid session repo");

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
