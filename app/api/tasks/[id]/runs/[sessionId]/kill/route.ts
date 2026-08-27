import { NextResponse, type NextRequest } from "next/server";
import { join } from "node:path";
import { readMeta, updateRun } from "@/libs/meta";
import { SESSIONS_DIR } from "@/libs/paths";
import { killChild } from "@/libs/spawnRegistry";
import { releaseRepoReservation } from "@/libs/repoReservation";
import { isValidTaskId } from "@/libs/tasks";
import { badRequest, isValidSessionId } from "@/libs/validate";
import { ok } from "@/libs/apiResponse";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string; sessionId: string }> };

export async function POST(_req: NextRequest, ctx: Ctx) {
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

  const killed = killChild(sessionId);
  if (!killed) {
    return NextResponse.json(
      { error: "no live process for this session" },
      { status: 404 },
    );
  }

  const cancelled = await updateRun(
    dir,
    sessionId,
    { status: "cancelled", endedAt: new Date().toISOString() },
    (r) => r.status === "running",
  );
  if (cancelled.run) {
    releaseRepoReservation(cancelled.run.repo, sessionId);
  }

  return ok({ sessionId, action: "killed" });
}
