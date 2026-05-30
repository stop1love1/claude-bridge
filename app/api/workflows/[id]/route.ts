import { NextResponse, type NextRequest } from "next/server";
import {
  deleteWorkflow,
  getWorkflow,
  updateWorkflow,
  type CronSchedule,
} from "@/libs/workflowStore";
import { safeErrorMessage } from "@/libs/errorResponse";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

interface PatchBody {
  name?: string;
  enabled?: boolean;
  schedule?: CronSchedule;
  app?: string | null;
  title?: string;
  body?: string;
}

/** PATCH /api/workflows/[id] — update fields / toggle enabled. */
export async function PATCH(req: NextRequest, ctx: Ctx) {
  const { id } = await ctx.params;
  if (!getWorkflow(id)) {
    return NextResponse.json({ error: "workflow not found" }, { status: 404 });
  }
  let body: PatchBody;
  try {
    body = (await req.json()) as PatchBody;
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  try {
    const wf = updateWorkflow(id, body);
    if (!wf) return NextResponse.json({ error: "workflow not found" }, { status: 404 });
    return NextResponse.json(wf);
  } catch (err) {
    return NextResponse.json({ error: safeErrorMessage(err, "invalid workflow") }, { status: 400 });
  }
}

/** DELETE /api/workflows/[id]. */
export async function DELETE(_req: NextRequest, ctx: Ctx) {
  const { id } = await ctx.params;
  const removed = deleteWorkflow(id);
  if (!removed) return NextResponse.json({ error: "workflow not found" }, { status: 404 });
  return NextResponse.json({ ok: true });
}
