import { NextResponse, type NextRequest } from "next/server";
import { join } from "node:path";
import { readMeta, updateRun } from "@/libs/meta";
import { SESSIONS_DIR } from "@/libs/paths";
import { killChild } from "@/libs/spawnRegistry";
import { isValidTaskId } from "@/libs/tasks";
import { badRequest, isValidSessionId } from "@/libs/validate";
import { ok } from "@/libs/apiResponse";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string; sessionId: string }> };

/**
 * Kill a live child process registered in the in-memory spawn registry
 * and flip its meta.json run to `failed`. Idempotent for the
 * already-exited case (returns 404 with `no live process`).
 *
 * SIGTERM first, escalates to SIGKILL after 3s — see `spawnRegistry.ts`.
 */
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

  // Flip to failed only if still running — never clobber a final state
  // the run may have just transitioned to (race against the lifecycle
  // helper's exit handler). The precondition runs inside the per-task
  // lock against the freshest on-disk row, so the read-then-patch
  // window can't be raced by the exit-handler's own `failed` write.
  await updateRun(
    dir,
    sessionId,
    { status: "failed", endedAt: new Date().toISOString() },
    (r) => r.status === "running",
  );

  return ok({ sessionId, action: "killed" });
}
