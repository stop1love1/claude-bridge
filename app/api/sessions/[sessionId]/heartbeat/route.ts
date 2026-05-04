import { NextResponse, type NextRequest } from "next/server";
import { verifyRequestAuthOrInternal } from "@/libs/auth";
import { recordHeartbeat } from "@/libs/heartbeat";
import { badRequest, isValidSessionId } from "@/libs/validate";
import { ok } from "@/libs/apiResponse";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ sessionId: string }> };

/**
 * Heartbeat ingest. Fired by the PreToolUse hook
 * (`agents/permission-hook.cjs`) on every tool boundary, regardless of
 * permission mode — even `bypassPermissions` children call this so the
 * stale-run reaper has a push-based "agent is alive" signal in addition
 * to the JSONL-mtime fallback. Fire-and-forget from the hook's POV.
 *
 * Auth: cookie OR internal token. Spawned children carry the internal
 * token in `BRIDGE_INTERNAL_TOKEN` for exactly this kind of self-report.
 *
 * Body is intentionally empty / ignored. The sessionId in the path is
 * the only datum we need; recording timestamp = `Date.now()` keeps the
 * client honest about when the heartbeat actually landed (a child can't
 * lie about being alive five minutes ago).
 */
export async function POST(req: NextRequest, ctx: Ctx) {
  if (!verifyRequestAuthOrInternal(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const { sessionId } = await ctx.params;
  if (!isValidSessionId(sessionId)) return badRequest("invalid sessionId");
  recordHeartbeat(sessionId);
  return ok();
}
