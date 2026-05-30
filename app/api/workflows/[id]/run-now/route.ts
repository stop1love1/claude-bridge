import { NextResponse, type NextRequest } from "next/server";
import { getWorkflow, recordWorkflowFire } from "@/libs/workflowStore";
import { createTask } from "@/libs/tasksStore";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/**
 * POST /api/workflows/[id]/run-now
 *
 * Manually fire a workflow now: mint an auto-flagged task (the scheduler's
 * auto-queue then dispatches it, honoring the concurrency cap) and record
 * the fire. Returns the created task. Does not require the workflow to be
 * enabled — "run now" is an explicit operator action.
 */
export async function POST(_req: NextRequest, ctx: Ctx) {
  const { id } = await ctx.params;
  const wf = getWorkflow(id);
  if (!wf) return NextResponse.json({ error: "workflow not found" }, { status: 404 });

  const task = createTask({
    title: wf.title,
    body: wf.body,
    app: wf.app,
    auto: true,
    origin: "cron",
    workflowId: wf.id,
  });
  recordWorkflowFire(wf.id, task.id, Date.now());
  return NextResponse.json({ ok: true, task }, { status: 201 });
}
