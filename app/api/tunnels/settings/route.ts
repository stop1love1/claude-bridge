import { NextResponse, type NextRequest } from "next/server";
import { getTunnelAutoStart, setTunnelAutoStart, type TunnelAutoStart } from "@/libs/apps";
import { BRIDGE_PORT } from "@/libs/paths";
import { checkCsrf } from "@/libs/csrf";
import { checkRateLimit } from "@/libs/rateLimit";
import { getClientIp } from "@/libs/clientIp";
import { verifyRequestActor } from "@/libs/auth";
import { badRequest } from "@/libs/validate";

export const dynamic = "force-dynamic";

const VALID_PROVIDERS = new Set(["localtunnel", "ngrok"]);

const DEFAULT_AUTO_START: TunnelAutoStart = {
  enabled: false,
  provider: "localtunnel",
  port: BRIDGE_PORT,
};

/**
 * GET/PUT /api/tunnels/settings
 *
 * Operator-only config for "auto-start a tunnel at boot"
 * (`bridge.json#tunnels.autoStart`), read by
 * `libs/tunnels.ts#maybeAutoStartTunnel()` from `instrumentation.ts`.
 * `/api/tunnels/*` is already denied to guests by the share allowlist
 * (see `libs/guestAccess.ts`), same as the rest of this route family
 * (`providers/ngrok/install`, `providers/ngrok/authtoken`) — the PUT
 * below still adds an explicit CSRF → rate-limit → operator-actor check
 * since it mutates persisted config, matching the guard shape used by
 * `app/api/tasks/[id]/plan/approve/route.ts`.
 */
export function GET() {
  return NextResponse.json(getTunnelAutoStart() ?? DEFAULT_AUTO_START);
}

interface PutBody {
  enabled?: unknown;
  provider?: unknown;
  port?: unknown;
}

export async function PUT(req: NextRequest) {
  const csrf = checkCsrf(req);
  if (!csrf.ok) {
    return NextResponse.json({ error: "csrf check failed", reason: csrf.reason ?? null }, { status: 403 });
  }
  const denied = checkRateLimit("tunnels:settings", getClientIp(req.headers), 20, 60_000);
  if (denied) {
    return NextResponse.json(denied.body, { status: denied.status, headers: denied.headers });
  }
  const actor = verifyRequestActor(req);
  if (!actor || actor.kind !== "operator") {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let body: PutBody;
  try { body = (await req.json()) as PutBody; } catch { return badRequest("invalid JSON body"); }

  if (typeof body.enabled !== "boolean") {
    return badRequest("enabled must be a boolean");
  }
  if (typeof body.provider !== "string" || !VALID_PROVIDERS.has(body.provider)) {
    return badRequest("provider must be one of: localtunnel, ngrok");
  }
  const port = Number(body.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return badRequest("port must be an integer 1-65535");
  }

  setTunnelAutoStart({
    enabled: body.enabled,
    provider: body.provider as TunnelAutoStart["provider"],
    port,
  });
  return NextResponse.json(getTunnelAutoStart() ?? DEFAULT_AUTO_START);
}
