import { NextResponse, type NextRequest } from "next/server";
import { join } from "node:path";
import { getTask } from "@/libs/tasksStore";
import { readMeta, type Run } from "@/libs/meta";
import { isTerminal } from "@/libs/runStatus";
import { resumeSessionWithLifecycle } from "@/libs/resumeSession";
import { denyTaskToolNames } from "@/libs/spawn";
import { spawnCoordinatorForTask } from "@/libs/coordinator";
import { isOrchestrationRole } from "@/libs/roleRegistry";
import { BRIDGE_ROOT, SESSIONS_DIR } from "@/libs/paths";
import { isValidTaskId } from "@/libs/tasks";
import { badRequest } from "@/libs/validate";
import { withInFlight } from "@/libs/inFlight";
import { serverError } from "@/libs/errorResponse";

export const dynamic = "force-dynamic";

function startedMs(run: Run): number {
  const t = run.startedAt ? Date.parse(run.startedAt) : NaN;
  return Number.isNaN(t) ? -Infinity : t;
}

/**
 * The orchestrator row to resume. A task accumulates several coordinator rows
 * over its life (an exited one from the first spawn, the live one that replaced
 * it), and they are stored in append order — so taking the first match resumes
 * a session that is already dead. Prefer a row that is still live; among equals
 * (or when all are terminal) take the most recently started, falling back to the
 * last appended when `startedAt` is missing or unparseable.
 */
function pickOrchestratorRun(runs: Run[]): Run | null {
  const orchestrators = runs.filter((r) => isOrchestrationRole(r.role));
  if (orchestrators.length === 0) return null;
  const live = orchestrators.filter((r) => !isTerminal(r.status));
  const pool = live.length > 0 ? live : orchestrators;
  return pool.reduce((best, r) => (startedMs(r) >= startedMs(best) ? r : best));
}

type Ctx = { params: Promise<{ id: string }> };

export async function POST(_req: NextRequest, ctx: Ctx) {
  const { id } = await ctx.params;
  if (!isValidTaskId(id)) return badRequest("invalid task id");

  const result = await withInFlight("task:continue", id, async () => {
    try {
      const task = getTask(id);
      if (!task) {
        return NextResponse.json({ error: "task not found" }, { status: 404 });
      }

      const meta = readMeta(join(SESSIONS_DIR, id));
      if (!meta) {
        return NextResponse.json({ error: "meta not found" }, { status: 404 });
      }

      // The only run this route resumes is the task's orchestrator, resolved
      // through the role registry rather than a literal "coordinator" here.
      const coordinatorRun = pickOrchestratorRun(meta.runs);
      if (coordinatorRun) {
        // No repo reservation is taken. An orchestrator runs from BRIDGE_ROOT
        // and never edits the app's shared working tree, and this route held
        // the reservation until the resumed process exited — so a coordinator
        // resumed here used to lock its own repo and 409 every child it then
        // dispatched into it (the self-target deadlock). It also must be able
        // to regain control while one of its children still holds the repo.
        const message = `Continue from where you left off for bridge task ${id}. Read sessions/${id}/meta.json to see which child agents are still 'running', which 'done', and which 'failed'. If all children are done, finalize per prompts/coordinator-playbook.md §5. Otherwise re-orchestrate as needed.`;
        resumeSessionWithLifecycle({
          cwd: BRIDGE_ROOT,
          sessionId: coordinatorRun.sessionId,
          message,
          settings: { mode: "bypassPermissions", disallowedTools: denyTaskToolNames() },
          context: `coordinator-continue ${id}`,
        });
        return NextResponse.json({ action: "resumed", sessionId: coordinatorRun.sessionId });
      }

      void spawnCoordinatorForTask(task);
      return NextResponse.json({ action: "spawned" });
    } catch (err) {
      return NextResponse.json(serverError(err, "tasks:continue"), { status: 500 });
    }
  });
  if (result === null) {
    return NextResponse.json(
      { error: "continue already in flight for this task" },
      { status: 409 },
    );
  }
  return result;
}
