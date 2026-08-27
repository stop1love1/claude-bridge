import { NextResponse, type NextRequest } from "next/server";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { resolveSessionFile, tailJsonl, tailJsonlBefore } from "@/libs/sessions";
import { isRegisteredRepoPath } from "@/libs/sessionAccess";
import { badRequest } from "@/libs/validate";
import { verifyRequestActor } from "@/libs/auth";
import { readMeta } from "@/libs/meta";
import { resolveRepoCwd } from "@/libs/repos";
import { BRIDGE_ROOT, SESSIONS_DIR, readBridgeMd } from "@/libs/paths";
import { guestBoundRepoValue } from "@/libs/guestSessionRepo";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ sessionId: string }> };

export async function GET(req: NextRequest, ctx: Ctx) {
  const { sessionId } = await ctx.params;
  const { searchParams } = new URL(req.url);
  const repoPath = searchParams.get("repo");
  const sinceParam = searchParams.get("since");
  const beforeParam = searchParams.get("before");

  const actor = verifyRequestActor(req);
  let effectiveRepoPath = repoPath;
  if (actor?.kind === "guest") {
    const ownerMeta = readMeta(join(SESSIONS_DIR, actor.taskId));
    const sessionRepo = ownerMeta?.runs.find((r) => r.sessionId === sessionId)?.repo ?? null;
    const sessionRepoPath = sessionRepo ? resolveRepoCwd(readBridgeMd(), BRIDGE_ROOT, sessionRepo) : null;
    effectiveRepoPath = guestBoundRepoValue({
      actorKind: "guest",
      callerValue: repoPath,
      sessionValue: sessionRepoPath,
    });
  }

  if (!isRegisteredRepoPath(effectiveRepoPath)) return badRequest("invalid session repo");
  const file = resolveSessionFile(effectiveRepoPath, sessionId);
  if (!file) return badRequest("invalid session repo");

  if (beforeParam !== null) {
    const before = Number(beforeParam);
    if (!existsSync(file)) {
      return NextResponse.json({ lines: [], fromOffset: 0, beforeOffset: before, lineOffsets: [] });
    }
    const result = await tailJsonlBefore(file, before);
    return NextResponse.json(result);
  }

  const since = Number(sinceParam ?? 0);
  if (!existsSync(file)) return NextResponse.json({ lines: [], offset: since, lineOffsets: [] });
  const result = await tailJsonl(file, since);
  return NextResponse.json(result);
}
