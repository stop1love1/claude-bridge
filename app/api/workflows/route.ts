import { NextResponse, type NextRequest } from "next/server";
import {
  createWorkflow,
  getSchedulerSettings,
  listWorkflows,
  type CronSchedule,
} from "@/libs/workflowStore";
import { getSchedulerStatus } from "@/libs/scheduler";
import { safeErrorMessage } from "@/libs/errorResponse";

export const dynamic = "force-dynamic";

/**
 * GET /api/workflows
 *
 * One-shot snapshot for the "Quy trình" page: the workflow list, the
 * global scheduler settings (auto-queue + concurrency cap), and the
 * 24/7 scheduler/lock status.
 */
export function GET() {
  return NextResponse.json({
    workflows: listWorkflows(),
    settings: getSchedulerSettings(),
    status: getSchedulerStatus(),
  });
}

interface CreateBody {
  name?: string;
  schedule?: CronSchedule;
  app?: string | null;
  title?: string;
  body?: string;
  enabled?: boolean;
}

/** POST /api/workflows — create a cron workflow. */
export async function POST(req: NextRequest) {
  let body: CreateBody;
  try {
    body = (await req.json()) as CreateBody;
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  if (!body.schedule) {
    return NextResponse.json({ error: "schedule required" }, { status: 400 });
  }
  if (!body.title || !body.title.trim()) {
    return NextResponse.json({ error: "title required" }, { status: 400 });
  }
  try {
    const wf = createWorkflow({
      name: body.name ?? body.title,
      schedule: body.schedule,
      app: body.app ?? null,
      title: body.title,
      body: body.body ?? "",
      enabled: body.enabled ?? true,
    });
    return NextResponse.json(wf, { status: 201 });
  } catch (err) {
    // createWorkflow throws on an invalid schedule / missing title.
    return NextResponse.json({ error: safeErrorMessage(err, "invalid workflow") }, { status: 400 });
  }
}
