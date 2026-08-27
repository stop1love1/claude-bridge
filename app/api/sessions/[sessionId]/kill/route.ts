import { NextResponse, type NextRequest } from "next/server";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { readMeta, updateRun } from "@/libs/meta";
import { SESSIONS_DIR } from "@/libs/paths";
import { killChild } from "@/libs/spawnRegistry";
import { releaseRepoReservation } from "@/libs/repoReservation";
import { badRequest, isValidSessionId } from "@/libs/validate";
import { ok } from "@/libs/apiResponse";
import { clearQueue } from "@/libs/messageQueue";
import { logInfo } from "@/libs/log";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ sessionId: string }> };

export async function POST(_req: NextRequest, ctx: Ctx) {
  const { sessionId } = await ctx.params;
  if (!isValidSessionId(sessionId)) return badRequest("invalid sessionId");

  const killed = killChild(sessionId);
  const dropped = clearQueue(sessionId);
  if (dropped > 0) {
    logInfo(
      "msg-queue",
      `cleared ${dropped} queued message(s) on kill for ${sessionId.slice(0, 8)}`,
    );
  }
  if (!killed) {
    return NextResponse.json(
      { error: "no live process for this session" },
      { status: 404 },
    );
  }

  if (existsSync(SESSIONS_DIR)) {
    for (const taskId of readdirSync(SESSIONS_DIR)) {
      const dir = join(SESSIONS_DIR, taskId);
      const meta = readMeta(dir);
      if (!meta) continue;
      const run = meta.runs.find((r) => r.sessionId === sessionId);
      if (!run) continue;
      const cancelled = await updateRun(
        dir,
        sessionId,
        { status: "cancelled", endedAt: new Date().toISOString() },
        (r) => r.status === "running",
      );
      if (cancelled.applied && cancelled.run) {
        releaseRepoReservation(cancelled.run.repo, sessionId);
      }
      break;
    }
  }

  return ok({ sessionId, action: "killed" });
}
