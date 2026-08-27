import { NextResponse, type NextRequest } from "next/server";
import { join } from "node:path";
import { appendRun, readMeta, updateRun } from "@/libs/meta";
import { SESSIONS_DIR } from "@/libs/paths";
import { isBackwardStatusTransition, type RunStatus } from "@/libs/runStatus";
import { isValidTaskId } from "@/libs/tasks";
import {
  badRequest,
  isValidAgentRole,
  isValidRepoLabel,
  isValidRunStatus,
  isValidSessionId,
} from "@/libs/validate";
import { ok } from "@/libs/apiResponse";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

interface LinkBody {
  sessionId: string;
  role: string;
  repo: string;
  status?: RunStatus;
  parentSessionId?: string | null;
}

export async function POST(req: NextRequest, ctx: Ctx) {
  const { id } = await ctx.params;
  if (!isValidTaskId(id)) return badRequest("invalid task id");

  let body: Partial<LinkBody>;
  try {
    body = (await req.json()) as Partial<LinkBody>;
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  if (!body.sessionId || !body.role || !body.repo) {
    return NextResponse.json(
      { error: "sessionId, role, and repo are required" },
      { status: 400 },
    );
  }
  if (!isValidSessionId(body.sessionId)) return badRequest("invalid sessionId");
  if (!isValidAgentRole(body.role)) return badRequest("invalid role");
  if (!isValidRepoLabel(body.repo)) return badRequest("invalid repo");
  if (body.status !== undefined && !isValidRunStatus(body.status)) {
    return badRequest("invalid status");
  }
  if (body.parentSessionId !== undefined && body.parentSessionId !== null
      && !isValidSessionId(body.parentSessionId)) {
    return badRequest("invalid parentSessionId");
  }

  const dir = join(SESSIONS_DIR, id);
  const meta = readMeta(dir);
  if (!meta) return NextResponse.json({ error: "task not found" }, { status: 404 });

  if (body.parentSessionId) {
    const parentInTask = meta.runs.some(
      (r) => r.sessionId === body.parentSessionId,
    );
    if (!parentInTask) {
      return NextResponse.json(
        { error: "parentSessionId does not belong to this task" },
        { status: 403 },
      );
    }
  }

  const existing = meta.runs.find((r) => r.sessionId === body.sessionId);
  if (existing) {
    await updateRun(
      dir,
      body.sessionId,
      {
        role: body.role,
        repo: body.repo,
        ...(body.status ? { status: body.status } : {}),
      },
      (r) => !body.status || !isBackwardStatusTransition(r.status, body.status),
    );
  } else {
    if (body.role !== "coordinator" && !body.parentSessionId) {
      return NextResponse.json(
        {
          error:
            "non-coordinator self-register requires parentSessionId — was the bridge expected to pre-register this child via POST /api/tasks/<id>/agents?",
        },
        { status: 400 },
      );
    }
    await appendRun(dir, {
      sessionId: body.sessionId,
      role: body.role,
      repo: body.repo,
      status: body.status ?? "running",
      startedAt: new Date().toISOString(),
      endedAt: null,
      parentSessionId: body.parentSessionId ?? null,
    });
  }

  return ok({ taskId: id, sessionId: body.sessionId });
}
