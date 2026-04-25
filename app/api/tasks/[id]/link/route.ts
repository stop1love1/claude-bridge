import { NextResponse, type NextRequest } from "next/server";
import { join } from "node:path";
import { appendRun, readMeta, updateRun } from "@/lib/meta";
import { SESSIONS_DIR } from "@/lib/paths";
import { isValidTaskId } from "@/lib/tasks";
import {
  badRequest,
  isValidAgentRole,
  isValidRepoLabel,
  isValidRunStatus,
  isValidSessionId,
} from "@/lib/validate";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

interface LinkBody {
  sessionId: string;
  role: string;
  repo: string;
  status?: "queued" | "running" | "done" | "failed" | "stale";
}

/**
 * Attach an existing Claude Code session to a task's meta.json.
 *
 * Idempotent: if the session is already in the task's runs, the entry is
 * updated in place (role/repo/status). Otherwise a new run is appended.
 */
export async function POST(req: NextRequest, ctx: Ctx) {
  const { id } = await ctx.params;
  if (!isValidTaskId(id)) return badRequest("invalid task id");

  const body = (await req.json()) as Partial<LinkBody>;
  if (!body.sessionId || !body.role || !body.repo) {
    return NextResponse.json(
      { error: "sessionId, role, and repo are required" },
      { status: 400 },
    );
  }
  // CRIT-4 / CRIT-5 / M3: gate every untrusted body field before it
  // hits meta.json (where it ends up serialized into per-task state)
  // or the prompt route's `${role}-${repo}.prompt.txt` filename template.
  if (!isValidSessionId(body.sessionId)) return badRequest("invalid sessionId");
  if (!isValidAgentRole(body.role)) return badRequest("invalid role");
  if (!isValidRepoLabel(body.repo)) return badRequest("invalid repo");
  if (body.status !== undefined && !isValidRunStatus(body.status)) {
    return badRequest("invalid status");
  }

  const dir = join(SESSIONS_DIR, id);
  const meta = readMeta(dir);
  if (!meta) return NextResponse.json({ error: "task not found" }, { status: 404 });

  const existing = meta.runs.find((r) => r.sessionId === body.sessionId);
  if (existing) {
    updateRun(dir, body.sessionId, {
      role: body.role,
      repo: body.repo,
      ...(body.status ? { status: body.status } : {}),
    });
  } else {
    appendRun(dir, {
      sessionId: body.sessionId,
      role: body.role,
      repo: body.repo,
      status: body.status ?? "running",
      startedAt: new Date().toISOString(),
      endedAt: null,
    });
  }

  return NextResponse.json({ ok: true, taskId: id, sessionId: body.sessionId });
}
