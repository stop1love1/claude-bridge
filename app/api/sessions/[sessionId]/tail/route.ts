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

  // C4 follow-up (task 6 review, defence in depth): `?repo=` is an
  // absolute path checked only against "is this SOME registered app"
  // (isRegisteredRepoPath below) — it never confirms the path belongs
  // to THIS sessionId. Once /message can no longer be used to spawn a
  // session into a foreign app (see guestSessionRepo.ts), a guest has
  // no way to CREATE one — but without this, a guest could still tail
  // any of their task's session ids while pointing `repo` at a
  // different registered app's project dir. For a guest, discard the
  // query value and use the repo recorded on the session's own run
  // instead; operators may tail "free chat" sessions with no owning
  // run, so their existing query-driven behaviour is unchanged.
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

  // Whitelist repo against registered apps before hitting the file resolver.
  if (!isRegisteredRepoPath(effectiveRepoPath)) return badRequest("invalid session repo");
  const file = resolveSessionFile(effectiveRepoPath, sessionId);
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
