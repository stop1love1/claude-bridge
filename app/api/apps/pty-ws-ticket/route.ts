import { NextResponse, type NextRequest } from "next/server";
import { DEMO_MODE } from "@/libs/demoMode";
import { verifyRequestAuthOrInternal } from "@/libs/auth";
import { mintPtyWsTicket } from "@/libs/ptyWsTickets";

export const dynamic = "force-dynamic";

const TTL_MS = 60_000;

function ptyReady(): boolean {
  return process.env.BRIDGE_PTY_READY === "1";
}

export async function POST(req: NextRequest) {
  if (DEMO_MODE) {
    return NextResponse.json({ error: "demo mode" }, { status: 503 });
  }
  const session = verifyRequestAuthOrInternal({
    cookies: req.cookies,
    headers: req.headers,
  });
  if (!session) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const ticket = mintPtyWsTicket(session.sub);
  return NextResponse.json({ ticket, ttlMs: TTL_MS, ptyReady: ptyReady() });
}
