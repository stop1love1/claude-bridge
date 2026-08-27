import { NextResponse, type NextRequest } from "next/server";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { SESSIONS_DIR } from "@/libs/paths";
import { isValidTaskId } from "@/libs/tasks";
import { badRequest } from "@/libs/validate";
import { readMeta } from "@/libs/meta";
import { computeGateStatus, type GateStatus } from "@/libs/gateStatus";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: NextRequest, ctx: Ctx) {
  const { id } = await ctx.params;
  if (!isValidTaskId(id)) return badRequest("invalid task id");
  const dir = join(SESSIONS_DIR, id);
  const path = join(dir, "summary.md");
  if (!existsSync(path)) return NextResponse.json({ error: "not found" }, { status: 404 });
  const summary = readFileSync(path, "utf8");
  const meta = readMeta(dir);
  const gateStatus: GateStatus = meta ? computeGateStatus(meta) : { gates: [], allGreen: true };
  return NextResponse.json({ summary, gateStatus });
}
