import { NextResponse, type NextRequest } from "next/server";
import { getSchedulerSettings, getWorkflow } from "@/libs/workflowStore";
import { countActivePipelines, startWorkflowRun } from "@/libs/pipelineEngine";
import { safeErrorMessage } from "@/libs/errorResponse";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/**
 * POST /api/workflows/[id]/run
 *
 * Manually start a pipeline run: creates a task and dispatches stage 0;
 * the pipeline engine sequences the rest. Returns the created task id.
 * Allowed even when the workflow is disabled (an explicit operator action),
 * but still bounded by the global concurrency cap so button-mashing can't
 * spawn unbounded parallel runs.
 */
export async function POST(_req: NextRequest, ctx: Ctx) {
  const { id } = await ctx.params;
  const wf = getWorkflow(id);
  if (!wf) return NextResponse.json({ error: "workflow not found" }, { status: 404 });
  if (wf.stages.length === 0) {
    return NextResponse.json({ error: "workflow has no stages" }, { status: 400 });
  }
  const cap = getSchedulerSettings().maxConcurrentRuns;
  if (countActivePipelines() >= cap) {
    return NextResponse.json(
      { error: `concurrency cap reached (${cap} runs in flight) — wait for one to finish or raise the cap` },
      { status: 429 },
    );
  }
  try {
    const r = await startWorkflowRun(id);
    if (!r) return NextResponse.json({ error: "failed to start run" }, { status: 500 });
    return NextResponse.json({ ok: true, taskId: r.taskId }, { status: 201 });
  } catch (err) {
    return NextResponse.json({ error: safeErrorMessage(err, "run failed") }, { status: 500 });
  }
}
