import { NextResponse, type NextRequest } from "next/server";
import { updateTask, deleteTask, isValidSection } from "@/libs/tasksStore";
import { isValidTaskId, SECTION_DONE, SECTION_STATUS, type Task, type TaskSection } from "@/libs/tasks";
import { badRequest } from "@/libs/validate";
import { verifyRequestAuth } from "@/libs/auth";

export const dynamic = "force-dynamic";

const VALID_SECTIONS = Object.keys(SECTION_STATUS) as TaskSection[];
const DONE_SECTION = SECTION_DONE;

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

export async function DELETE(req: NextRequest, ctx: Ctx) {
  if (!verifyRequestAuth(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const { id } = await ctx.params;
  if (!isValidTaskId(id)) return badRequest("invalid task id");
  const result = await deleteTask(id);
  if (!result.ok) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json(result);
}
