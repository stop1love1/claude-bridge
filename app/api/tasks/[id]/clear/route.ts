import { NextResponse, type NextRequest } from "next/server";
import { getTask } from "@/libs/tasksStore";
import { spawnCoordinatorForTask } from "@/libs/coordinator";
import { isValidTaskId } from "@/libs/tasks";
import { badRequest } from "@/libs/validate";
import { withInFlight } from "@/libs/inFlight";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export async function POST(_req: NextRequest, ctx: Ctx) {
  const { id } = await ctx.params;
  if (!isValidTaskId(id)) return badRequest("invalid task id");
  const result = await withInFlight("task:clear", id, async () => {
    const task = getTask(id);
    if (!task) return NextResponse.json({ error: "task not found" }, { status: 404 });
    const sessionId = await spawnCoordinatorForTask(task);
    if (!sessionId) return NextResponse.json({ error: "spawn failed" }, { status: 500 });
    return NextResponse.json({ action: "spawned", sessionId });
  });
  if (result === null) {
    return NextResponse.json(
      { error: "clear already in flight for this task" },
      { status: 409 },
    );
  }
  return result;
}
