import { NextResponse, type NextRequest } from "next/server";
import { getTask } from "@/lib/tasksStore";
import { spawnCoordinatorForTask } from "@/lib/coordinator";
import { isValidTaskId } from "@/lib/tasks";
import { badRequest } from "@/lib/validate";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/**
 * Force-spawn a fresh coordinator for the task, regardless of any
 * existing runs. The old run entries stay in `meta.json` (so the user
 * can scroll back to them); a brand-new session takes over as the
 * active conversation.
 */
export async function POST(_req: NextRequest, ctx: Ctx) {
  const { id } = await ctx.params;
  if (!isValidTaskId(id)) return badRequest("invalid task id");
  const task = getTask(id);
  if (!task) return NextResponse.json({ error: "task not found" }, { status: 404 });
  const sessionId = spawnCoordinatorForTask(task);
  if (!sessionId) return NextResponse.json({ error: "spawn failed" }, { status: 500 });
  return NextResponse.json({ action: "spawned", sessionId });
}
