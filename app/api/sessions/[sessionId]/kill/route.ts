import { NextResponse, type NextRequest } from "next/server";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { readMeta, updateRun } from "@/libs/meta";
import { SESSIONS_DIR } from "@/libs/paths";
import { killChild } from "@/libs/spawnRegistry";
import { badRequest, isValidSessionId } from "@/libs/validate";
import { ok } from "@/libs/apiResponse";
import { clearQueue } from "@/libs/messageQueue";
import { logInfo } from "@/libs/log";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ sessionId: string }> };

/**
 * Stop a running claude subprocess attached to this session — the
 * "stop" button in the chat composer hits this.
 *
 * Works for both task-linked runs (we patch meta.json's run row to
 * `failed` if it was still `running`) and free/orphan sessions
 * (no meta.json scan needed). SIGTERM, escalates to SIGKILL after
 * 3s — see `spawnRegistry.killChild`.
 *
 * Idempotent: returns 404 with `no live process` if the registry
 * has nothing for this id.
 */
export async function POST(_req: NextRequest, ctx: Ctx) {
  const { sessionId } = await ctx.params;
  if (!isValidSessionId(sessionId)) return badRequest("invalid sessionId");

  const killed = killChild(sessionId);
  // Stop = "abort everything I had pending here". Drop any messages
  // the user queued behind the in-flight turn — keeping them would
  // surprise the user (they hit Stop expecting silence; instead the
  // queued message would fire moments later under a fresh resume).
  // Always run, even if `killed` is false — the queue can hold
  // entries while the session has just transitioned idle but the
  // operator's intent is still "cancel pending work for this id".
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

  // Best-effort: if this session is linked to a task, flip its run
  // entry to `failed`. Free/orphan sessions don't have a meta.json,
  // and that's fine — we just skip.
  if (existsSync(SESSIONS_DIR)) {
    for (const taskId of readdirSync(SESSIONS_DIR)) {
      const dir = join(SESSIONS_DIR, taskId);
      const meta = readMeta(dir);
      if (!meta) continue;
      const run = meta.runs.find((r) => r.sessionId === sessionId);
      if (!run) continue;
      await updateRun(
        dir,
        sessionId,
        { status: "failed", endedAt: new Date().toISOString() },
        (r) => r.status === "running",
      );
      break;
    }
  }

  return ok({ sessionId, action: "killed" });
}
