import { NextResponse, type NextRequest } from "next/server";
import { updateTask, deleteTask, isValidSection } from "@/lib/tasksStore";
import { isValidTaskId, type Task, type TaskSection } from "@/lib/tasks";
import { SECTION_STATUS } from "@/lib/tasks";
import { badRequest } from "@/lib/validate";
import { verifyRequestAuth } from "@/lib/auth";

export const dynamic = "force-dynamic";

const VALID_SECTIONS = Object.keys(SECTION_STATUS) as TaskSection[];
const DONE_SECTION: TaskSection = "DONE — not yet archived";

type Ctx = { params: Promise<{ id: string }> };

export async function PATCH(req: NextRequest, ctx: Ctx) {
  const { id } = await ctx.params;
  if (!isValidTaskId(id)) return badRequest("invalid task id");
  const patch = (await req.json()) as Partial<
    Pick<Task, "title" | "body" | "section" | "status" | "checked">
  >;

  if (patch.section && !isValidSection(patch.section)) {
    return NextResponse.json(
      { error: `invalid section: "${patch.section}". valid: ${VALID_SECTIONS.join(" | ")}` },
      { status: 400 },
    );
  }

  // CLAUDE.md contract: only the human user can promote a task to DONE
  // (by ticking the card's checkbox in the UI). Coordinators / children
  // hit this route via the internal-token path of `verifyRequestAuthOrInternal`,
  // which is why we use `verifyRequestAuth` (cookie-only) here. Without
  // this gate, a buggy or hostile coordinator can `curl PATCH … {"section":
  // "DONE — not yet archived"}` with the internal token and bypass the
  // user-confirmation review gate.
  if (patch.section === DONE_SECTION) {
    const cookie = verifyRequestAuth(req);
    if (!cookie) {
      return NextResponse.json(
        {
          error:
            "section=DONE requires user confirmation — only the browser UI may mark a task complete",
        },
        { status: 403 },
      );
    }
  }

  const updated = await updateTask(id, patch);
  if (!updated) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json(updated);
}

export async function DELETE(_req: NextRequest, ctx: Ctx) {
  const { id } = await ctx.params;
  if (!isValidTaskId(id)) return badRequest("invalid task id");
  const result = deleteTask(id);
  if (!result.ok) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json(result);
}
