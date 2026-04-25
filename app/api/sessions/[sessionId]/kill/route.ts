import { NextResponse, type NextRequest } from "next/server";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { readMeta, updateRun } from "@/lib/meta";
import { SESSIONS_DIR } from "@/lib/paths";
import { killChild } from "@/lib/spawnRegistry";

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
  if (!sessionId) {
    return NextResponse.json({ error: "sessionId required" }, { status: 400 });
  }

  const killed = killChild(sessionId);
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
      if (run.status === "running") {
        updateRun(dir, sessionId, {
          status: "failed",
          endedAt: new Date().toISOString(),
        });
      }
      break;
    }
  }

  return NextResponse.json({ ok: true, sessionId, action: "killed" });
}
