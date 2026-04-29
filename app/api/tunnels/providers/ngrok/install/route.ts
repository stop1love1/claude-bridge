import { NextResponse, type NextRequest } from "next/server";
import { installNgrok } from "@/libs/tunnels";
import { getClientIp } from "@/libs/clientIp";
import { checkRateLimit } from "@/libs/rateLimit";

export const dynamic = "force-dynamic";

/**
 * The installer shells out to winget / brew / a tarball download —
 * 30s+ of work, network bound, idempotent (a second call right after
 * a successful install is a no-op). 2 calls per 10-minute window per
 * IP is generous for the legitimate "click install, it failed,
 * retry" flow and stops anyone from looping it as a network probe.
 */
const NGROK_INSTALL_WINDOW_MS = 10 * 60 * 1000;
const NGROK_INSTALL_LIMIT_PER_IP = 2;

/**
 * POST /api/tunnels/providers/ngrok/install
 *
 * Cross-platform installer. Dispatches to winget / brew / tarball
 * download per `libs/tunnels.installerPlan`. Blocks until the install
 * finishes (or its timeout fires) and returns the combined log so the
 * UI can show what happened. Always 200 — `ok: false` in the body
 * signals failure rather than throwing through.
 */
export async function POST(req: NextRequest) {
  const ip = getClientIp(req.headers);
  const denied = checkRateLimit("tunnels:ngrok-install:ip", ip, NGROK_INSTALL_LIMIT_PER_IP, NGROK_INSTALL_WINDOW_MS);
  if (denied) {
    return NextResponse.json(denied.body, { status: denied.status, headers: denied.headers });
  }
  const result = await installNgrok();
  return NextResponse.json(result);
}
