import { NextResponse, type NextRequest } from "next/server";
import { join } from "node:path";
import { getTask } from "@/libs/tasksStore";
import { readMeta } from "@/libs/meta";
import { resumeSessionWithLifecycle } from "@/libs/resumeSession";
import { spawnCoordinatorForTask } from "@/libs/coordinator";
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

  // Dedup button-mash: a double-click that fires two POSTs would
  // otherwise call `resumeClaude` twice against the same session id
  // (undefined behavior at the claude CLI level) or fork two fresh
  // coordinators. The gate releases as soon as the spawn / resume
  // call returns — actual run lifecycle continues independently.
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
        const message = `Continue from where you left off for bridge task ${id}. Read sessions/${id}/meta.json to see which child agents are still 'running', which 'done', and which 'failed'. If all children are done, finalize per prompts/coordinator-playbook.md §5. Otherwise re-orchestrate as needed.`;
        // Resumed coordinator runs unattended too — without bypass, the
        // first tool call hangs on a non-existent permission TTY.
        // resumeSessionWithLifecycle (vs raw resumeClaude) flips the run
        // row done → running and wires the new process's exit so the UI
        // doesn't show stale "DONE" while the coordinator is actively
        // streaming a reply.
        resumeSessionWithLifecycle({
          cwd: BRIDGE_ROOT,
          sessionId: coordinatorRun.sessionId,
          message,
          settings: { mode: "bypassPermissions" },
          context: `coordinator-continue ${id}`,
        });
        return NextResponse.json({ action: "resumed", sessionId: coordinatorRun.sessionId });
      }

      // Fire-and-forget: the spawn writes the run row asynchronously
      // under the meta lock and the response shouldn't block on it.
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
