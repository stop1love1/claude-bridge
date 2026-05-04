import { NextResponse, type NextRequest } from "next/server";
import { DEMO_MODE } from "@/libs/demoMode";
import { verifyRequestAuthOrInternal } from "@/libs/auth";
import { mintPtyWsTicket } from "@/libs/ptyWsTickets";

export const dynamic = "force-dynamic";

const TTL_MS = 60_000;

/**
 * `BRIDGE_PTY_READY` is set by `scripts/bridge-http-server.ts` once it
 * has wired the `/api/apps/ws-pty` upgrade handler onto the HTTP server.
 * Plain `next dev` / `next start` never set it, so when this route is
 * served by the standard Next.js server (no upgrade handler) the WS
 * connect will hang and close 1006. We surface the flag in the ticket
 * response so the client can render an actionable "wrong server" error
 * instead of a cryptic 1006.
 */
function ptyReady(): boolean {
  return process.env.BRIDGE_PTY_READY === "1";
}

/**
 * POST — mint a short-lived, single-use ticket for `/api/apps/ws-pty`.
 * Browsers authenticate this request with the session cookie; the
 * WebSocket handshake may not attach the same cookie reliably, so the
 * client passes `ticket=` on the WS URL and the programmatic server
 * consumes it there.
 */
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
