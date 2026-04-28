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
  /**
   * Coordinator session id that spawned this child. Required for
   * non-coordinator roles so the agent tree can render parent/child
   * edges. The bridge usually pre-registers spawned children with
   * this field already populated; supply it here ONLY when self-
   * registering a child the bridge didn't pre-register (rare).
   */
  parentSessionId?: string | null;
}

/**
 * Attach an existing Claude Code session to a task's meta.json.
 *
 * Idempotent: if the session is already in the task's runs, the entry is
 * updated in place (role/repo/status). Otherwise a new run is appended,
 * but ONLY when the caller explicitly passes a parentSessionId (or the
 * role is "coordinator") — without that constraint, an orphan run
 * would land in the agent tree disconnected from any parent.
 *
 * Always preserves bridge-set fields (`startedAt`, `parentSessionId`,
 * `worktreePath`, etc.) on the existing-row branch — child curls only
 * carry role/repo/status.
 */
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
  // CRIT-4 / CRIT-5 / M3: gate every untrusted body field before it
  // hits meta.json (where it ends up serialized into per-task state)
  // or the prompt route's `${role}-${repo}.prompt.txt` filename template.
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

  const existing = meta.runs.find((r) => r.sessionId === body.sessionId);
  if (existing) {
    // Existing-row branch: ONLY patch the fields the child supplied.
    // Never overwrite startedAt / parentSessionId / worktreePath that
    // the bridge set when it pre-registered the run via /agents.
    await updateRun(dir, body.sessionId, {
      role: body.role,
      repo: body.repo,
      ...(body.status ? { status: body.status } : {}),
    });
  } else {
    // Refuse to land a child run that has no parent: it would orphan
    // forever in the agent tree. Coordinators are the one role that
    // legitimately self-registers without a parent (they ARE the
    // parent), so allow that path through.
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

  return NextResponse.json({ ok: true, taskId: id, sessionId: body.sessionId });
}
