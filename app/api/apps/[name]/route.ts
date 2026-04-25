import { NextResponse } from "next/server";
import { isValidAppName, removeApp } from "@/lib/apps";

export const dynamic = "force-dynamic";

export async function DELETE(
  _req: Request,
  ctx: { params: Promise<{ name: string }> },
) {
  const { name } = await ctx.params;
  if (!isValidAppName(name)) {
    return NextResponse.json({ error: "invalid app name" }, { status: 400 });
  }
  const ok = removeApp(name);
  if (!ok) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json({ ok: true });
}
