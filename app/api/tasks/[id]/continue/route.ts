import { NextResponse, type NextRequest } from "next/server";
import { join } from "node:path";
import { getTask } from "@/lib/tasksStore";
import { readMeta } from "@/lib/meta";
import { resumeClaude } from "@/lib/spawn";
import { spawnCoordinatorForTask } from "@/lib/coordinator";
import { BRIDGE_ROOT, SESSIONS_DIR } from "@/lib/paths";
import { isValidTaskId } from "@/lib/tasks";
import { badRequest } from "@/lib/validate";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export async function POST(_req: NextRequest, ctx: Ctx) {
  const { id } = await ctx.params;
  if (!isValidTaskId(id)) return badRequest("invalid task id");
  try {
    const task = getTask(id);
    if (!task) {
      return NextResponse.json({ error: "task not found" }, { status: 404 });
    }

    const meta = readMeta(join(SESSIONS_DIR, id));
    if (!meta) {
      return NextResponse.json({ error: "meta not found" }, { status: 404 });
    }

    const coordinatorRun = meta.runs.find((r) => r.role === "coordinator");
    if (coordinatorRun) {
      const message = `Continue from where you left off for bridge task ${id}. Read sessions/${id}/meta.json to see which child agents are still 'running', which 'done', and which 'failed'. If all children are done, finalize per coordinator.md §5. Otherwise re-orchestrate as needed.`;
      // Resumed coordinator runs unattended too — without bypass, the
      // first tool call hangs on a non-existent permission TTY.
      resumeClaude(BRIDGE_ROOT, coordinatorRun.sessionId, message, { mode: "bypassPermissions" });
      return NextResponse.json({ action: "resumed", sessionId: coordinatorRun.sessionId });
    }

    spawnCoordinatorForTask(task);
    return NextResponse.json({ action: "spawned" });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
