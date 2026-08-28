import { NextResponse, type NextRequest } from "next/server";
import { installProvider, isInstallableProvider } from "@/libs/tunnels";
import { getClientIp } from "@/libs/clientIp";
import { checkRateLimit } from "@/libs/rateLimit";
import { badRequest } from "@/libs/validate";

export const dynamic = "force-dynamic";

const INSTALL_WINDOW_MS = 10 * 60 * 1000;
const INSTALL_LIMIT_PER_IP = 2;

type Ctx = { params: Promise<{ name: string }> };

export async function POST(req: NextRequest, ctx: Ctx) {
  const { name } = await ctx.params;
  if (!isInstallableProvider(name)) {
    return badRequest("provider must be one of: ngrok, cloudflared");
  }
  const ip = getClientIp(req.headers);
  const denied = checkRateLimit(
    `tunnels:install:${name}:ip`,
    ip,
    INSTALL_LIMIT_PER_IP,
    INSTALL_WINDOW_MS,
  );
  if (denied) {
    return NextResponse.json(denied.body, { status: denied.status, headers: denied.headers });
  }
  const result = await installProvider(name);
  return NextResponse.json(result);
}
