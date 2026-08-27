import { NextResponse, type NextRequest } from "next/server";
import {
  createWorkflow,
  getSchedulerSettings,
  listWorkflows,
  type CronSchedule,
  type StageInput,
} from "@/libs/workflowStore";
import { getSchedulerStatus } from "@/libs/scheduler";
import { listPipelineRuns } from "@/libs/pipelineEngine";
import { safeErrorMessage } from "@/libs/errorResponse";

export const dynamic = "force-dynamic";

export function GET() {
  return NextResponse.json({
    workflows: listWorkflows(),
    settings: getSchedulerSettings(),
    status: getSchedulerStatus(),
    runs: listPipelineRuns(),
  });
}

interface CreateBody {
  name?: string;
  app?: string | null;
  stages?: StageInput[];
  enabled?: boolean;
  schedule?: CronSchedule | null;
}

export async function POST(req: NextRequest) {
  let body: CreateBody;
  try {
    body = (await req.json()) as CreateBody;
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  if (!body.name || !body.name.trim()) {
    return NextResponse.json({ error: "name required" }, { status: 400 });
  }
  if (!Array.isArray(body.stages) || body.stages.length === 0) {
    return NextResponse.json({ error: "at least one stage is required" }, { status: 400 });
  }
  try {
    const wf = createWorkflow({
      name: body.name,
      app: body.app ?? null,
      stages: body.stages,
      enabled: body.enabled ?? true,
      schedule: body.schedule ?? null,
    });
    return NextResponse.json(wf, { status: 201 });
  } catch (err) {
    return NextResponse.json({ error: safeErrorMessage(err, "invalid workflow") }, { status: 400 });
  }
}
