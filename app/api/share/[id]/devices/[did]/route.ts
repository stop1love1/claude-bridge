import { NextResponse, type NextRequest } from "next/server";
import { ok } from "@/libs/apiResponse";
import { revokeDevice } from "@/libs/shareStore";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string; did: string }> };

export async function DELETE(_req: NextRequest, ctx: Ctx) {
  const { id, did } = await ctx.params;
  if (!revokeDevice(id, did)) {
    return NextResponse.json({ error: "device not found" }, { status: 404 });
  }
  return ok();
}
