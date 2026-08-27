import { NextResponse, type NextRequest } from "next/server";
import { getTunnel, removeTunnel, stopTunnel } from "@/libs/tunnels";
import { ok } from "@/libs/apiResponse";

export const dynamic = "force-dynamic";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const t = getTunnel(id);
  if (!t) return NextResponse.json({ error: "not found" }, { status: 404 });
  return ok({ tunnel: t });
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const purge = req.nextUrl.searchParams.get("purge") === "1";
  const stopped = stopTunnel(id);
  if (!stopped && !purge) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  if (purge) removeTunnel(id);
  return ok();
}
