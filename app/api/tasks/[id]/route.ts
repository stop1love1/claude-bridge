import { NextResponse, type NextRequest } from "next/server";
import { updateTask, deleteTask, getTask, isValidSection } from "@/libs/tasksStore";
import { isValidTaskId, SECTION_DONE, SECTION_STATUS, SECTION_TODO, type Task, type TaskSection } from "@/libs/tasks";
import { badRequest, parseScheduledAt } from "@/libs/validate";
import { verifyRequestAuth } from "@/libs/auth";

export const dynamic = "force-dynamic";

const VALID_SECTIONS = Object.keys(SECTION_STATUS) as TaskSection[];
const DONE_SECTION = SECTION_DONE;

type Ctx = { params: Promise<{ id: string }> };

export async function PATCH(req: NextRequest, ctx: Ctx) {
  const { id } = await ctx.params;
  if (!isValidTaskId(id)) return badRequest("invalid task id");
  const raw = (await req.json()) as Partial<
    Pick<Task, "title" | "body" | "section" | "status" | "checked">
  > & { scheduledAt?: unknown };

  const { scheduledAt: rawScheduledAt, ...patch } = raw as typeof raw & {
    scheduledAt?: unknown;
  };
  let scheduledAt: string | null | undefined;
  if (rawScheduledAt !== undefined) {
    const parsed = parseScheduledAt(rawScheduledAt);
    if (!parsed.ok) return badRequest(`scheduledAt: ${parsed.error}`);
    scheduledAt = parsed.value;
    if (scheduledAt !== null) {
      // A schedule only means something while the card is waiting in TODO;
      // the section being patched in the same request counts.
      const current = getTask(id);
      if (!current) return NextResponse.json({ error: "not found" }, { status: 404 });
      const section = patch.section ?? current.section;
      if (section !== SECTION_TODO || current.checked) {
        return NextResponse.json(
          { error: "only a task waiting in TODO can be scheduled", section },
          { status: 409 },
        );
      }
    }
  }

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

  const updated = await updateTask(
    id,
    scheduledAt === undefined ? patch : { ...patch, scheduledAt },
  );
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
