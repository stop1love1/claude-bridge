import { NextResponse, type NextRequest } from "next/server";
import { join } from "node:path";
import { SESSIONS_DIR } from "@/lib/paths";
import { reapStaleRunsForDir } from "@/lib/staleRunReaper";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: NextRequest, ctx: Ctx) {
  const { id } = await ctx.params;
  const meta = await reapStaleRunsForDir(join(SESSIONS_DIR, id));
  if (!meta) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json(meta);
}
