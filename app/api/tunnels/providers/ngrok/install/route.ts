import { NextResponse, type NextRequest } from "next/server";
import { installNgrok } from "@/libs/tunnels";
import { getClientIp } from "@/libs/clientIp";
import { checkRateLimit } from "@/libs/rateLimit";

export const dynamic = "force-dynamic";

const NGROK_INSTALL_WINDOW_MS = 10 * 60 * 1000;
const NGROK_INSTALL_LIMIT_PER_IP = 2;

export async function POST(req: NextRequest) {
  const ip = getClientIp(req.headers);
  const denied = checkRateLimit("tunnels:ngrok-install:ip", ip, NGROK_INSTALL_LIMIT_PER_IP, NGROK_INSTALL_WINDOW_MS);
  if (denied) {
    return NextResponse.json(denied.body, { status: denied.status, headers: denied.headers });
  }
  const result = await installNgrok();
  return NextResponse.json(result);
}
