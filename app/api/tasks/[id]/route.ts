import { NextResponse, type NextRequest } from "next/server";
import { updateTask, deleteTask, isValidSection } from "@/lib/tasksStore";
import type { Task, TaskSection } from "@/lib/tasks";
import { SECTION_STATUS } from "@/lib/tasks";

export const dynamic = "force-dynamic";

const VALID_SECTIONS = Object.keys(SECTION_STATUS) as TaskSection[];

type Ctx = { params: Promise<{ id: string }> };

export async function PATCH(req: NextRequest, ctx: Ctx) {
  const { id } = await ctx.params;
  const patch = (await req.json()) as Partial<
    Pick<Task, "title" | "body" | "section" | "status" | "checked">
  >;

  if (patch.section && !isValidSection(patch.section)) {
    return NextResponse.json(
      { error: `invalid section: "${patch.section}". valid: ${VALID_SECTIONS.join(" | ")}` },
      { status: 400 },
    );
  }

  const updated = updateTask(id, patch);
  if (!updated) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json(updated);
}

export async function DELETE(_req: NextRequest, ctx: Ctx) {
  const { id } = await ctx.params;
  const result = deleteTask(id);
  if (!result.ok) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json(result);
}
