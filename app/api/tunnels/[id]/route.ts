import { NextResponse, type NextRequest } from "next/server";
import { getTunnel, removeTunnel, stopTunnel } from "@/lib/tunnels";

export const dynamic = "force-dynamic";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const t = getTunnel(id);
  if (!t) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json({ tunnel: t });
}

/**
 * DELETE /api/tunnels/<id>
 *
 * `?purge=1` removes the entry from the list entirely. Without it, we
 * just send SIGTERM and leave the row visible (status `stopped`) so
 * the operator can see exit logs. Idempotent — deleting an already-
 * stopped tunnel is a no-op.
 */
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
  return NextResponse.json({ ok: true });
}
