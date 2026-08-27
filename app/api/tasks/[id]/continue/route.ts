import { NextResponse, type NextRequest } from "next/server";
import { join } from "node:path";
import { getTask } from "@/libs/tasksStore";
import { readMeta } from "@/libs/meta";
import { resumeSessionWithLifecycle } from "@/libs/resumeSession";
import { denyTaskToolNames } from "@/libs/spawn";
import { spawnCoordinatorForTask } from "@/libs/coordinator";
import { getApp } from "@/libs/apps";
import { acquireRepoReservation, releaseRepoReservation } from "@/libs/repoReservation";
import { BRIDGE_ROOT, SESSIONS_DIR } from "@/libs/paths";
import { isValidTaskId } from "@/libs/tasks";
import { badRequest } from "@/libs/validate";
import { withInFlight } from "@/libs/inFlight";
import { serverError } from "@/libs/errorResponse";

export const dynamic = "force-dynamic";

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

      const coordinatorRun = meta.runs.find((r) => r.role === "coordinator");
      if (coordinatorRun) {
        const app = getApp(coordinatorRun.repo);
        const reservable = !!app && app.git.worktreeMode !== "enabled";
        if (reservable && app) {
          const reservation = acquireRepoReservation(app.name, coordinatorRun.sessionId);
          if (!reservation.ok) {
            return NextResponse.json(
              {
                error: "repo reserved",
                reason:
                  `app "${app.name}" has worktreeMode disabled, so only one run may touch its shared working tree at a time; ` +
                  `session ${reservation.heldBy} currently holds it — wait for it to finish, kill it, or enable worktreeMode to allow concurrent runs`,
                repo: app.name,
                heldBy: reservation.heldBy ?? null,
              },
              { status: 409 },
            );
          }
        }
        const message = `Continue from where you left off for bridge task ${id}. Read sessions/${id}/meta.json to see which child agents are still 'running', which 'done', and which 'failed'. If all children are done, finalize per prompts/coordinator-playbook.md §5. Otherwise re-orchestrate as needed.`;
        try {
          resumeSessionWithLifecycle({
            cwd: BRIDGE_ROOT,
            sessionId: coordinatorRun.sessionId,
            message,
            settings: { mode: "bypassPermissions", disallowedTools: denyTaskToolNames() },
            context: `coordinator-continue ${id}`,
          });
        } catch (e) {
          if (reservable && app) releaseRepoReservation(app.name, coordinatorRun.sessionId);
          throw e;
        }
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
