import { NextResponse, type NextRequest } from "next/server";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { SESSIONS_DIR } from "@/libs/paths";
import { isValidTaskId } from "@/libs/tasks";
import { badRequest } from "@/libs/validate";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: NextRequest, ctx: Ctx) {
  const { id } = await ctx.params;
  if (!isValidTaskId(id)) return badRequest("invalid task id");
  const path = join(SESSIONS_DIR, id, "summary.md");
  if (!existsSync(path)) return NextResponse.json({ error: "not found" }, { status: 404 });
  const summary = readFileSync(path, "utf8");
  return NextResponse.json({ summary });
}
