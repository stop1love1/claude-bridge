import { NextResponse, type NextRequest } from "next/server";
import { listTunnels, startTunnel, type TunnelProvider } from "@/libs/tunnels";

export const dynamic = "force-dynamic";

export function GET() {
  return NextResponse.json({ tunnels: listTunnels() });
}

interface CreateBody {
  port?: unknown;
  provider?: unknown;
  label?: unknown;
  subdomain?: unknown;
}

const VALID_PROVIDERS: ReadonlySet<TunnelProvider> = new Set(["localtunnel", "ngrok"]);

/**
 * POST /api/tunnels
 *
 * Body: `{ port: number, provider: "localtunnel" | "ngrok", label?: string }`.
 * Spawns the appropriate client; the tunnel starts in `starting`
 * state and flips to `running` once stdout reveals the public URL.
 * Auth gating is handled by `proxy.ts` — this route inherits the same
 * cookie/CSRF checks every other `/api/*` endpoint uses.
 */
export async function POST(req: NextRequest) {
  let body: CreateBody;
  try {
    body = (await req.json()) as CreateBody;
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const port = Number(body.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return NextResponse.json(
      { error: "port must be an integer 1-65535" },
      { status: 400 },
    );
  }
  const provider = (typeof body.provider === "string" ? body.provider : "localtunnel") as TunnelProvider;
  if (!VALID_PROVIDERS.has(provider)) {
    return NextResponse.json(
      { error: `provider must be one of: ${Array.from(VALID_PROVIDERS).join(", ")}` },
      { status: 400 },
    );
  }
  const label = typeof body.label === "string" ? body.label : undefined;
  const subdomain = typeof body.subdomain === "string" ? body.subdomain : undefined;
  try {
    const entry = startTunnel({ port, provider, label, subdomain });
    return NextResponse.json({ tunnel: entry }, { status: 201 });
  } catch (err) {
    return NextResponse.json(
      { error: (err as Error).message || "failed to start tunnel" },
      { status: 400 },
    );
  }
}
