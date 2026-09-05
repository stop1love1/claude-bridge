import { NextResponse, type NextRequest } from "next/server";
import { dispatchTodoTask } from "@/libs/dispatchTodoTask";
import { isValidTaskId } from "@/libs/tasks";
import { badRequest } from "@/libs/validate";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/**
 * Start a task that has been waiting in TODO (a hand-controlled draft, or
 * one the board just dragged to DOING). Spawns a fresh coordinator.
 */
export async function POST(_req: NextRequest, ctx: Ctx) {
  const { id } = await ctx.params;
  if (!isValidTaskId(id)) return badRequest("invalid task id");

  const r = await dispatchTodoTask(id);
  if (r.action === "spawned") return NextResponse.json(r);
  if (r.action === "skipped") {
    const status = r.reason === "task not found" ? 404 : 409;
    return NextResponse.json({ ...r, error: r.reason }, { status });
  }
  return NextResponse.json({ ...r, error: r.reason }, { status: 500 });
}
