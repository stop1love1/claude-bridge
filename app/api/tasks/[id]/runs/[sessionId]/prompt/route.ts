import { NextResponse, type NextRequest } from "next/server";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { readMeta } from "@/lib/meta";
import { SESSIONS_DIR } from "@/lib/paths";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string; sessionId: string }> };

export async function GET(_req: NextRequest, ctx: Ctx) {
  const { id, sessionId } = await ctx.params;
  const dir = join(SESSIONS_DIR, id);
  const meta = readMeta(dir);
  if (!meta) return NextResponse.json({ error: "task not found" }, { status: 404 });
  const run = meta.runs.find(r => r.sessionId === sessionId);
  if (!run) return NextResponse.json({ error: "run not found" }, { status: 404 });
  const file = join(dir, `${run.role}-${run.repo}.prompt.txt`);
  if (!existsSync(file)) return NextResponse.json({ error: "prompt not saved" }, { status: 404 });
  const prompt = readFileSync(file, "utf8");
  return NextResponse.json({ prompt });
}
