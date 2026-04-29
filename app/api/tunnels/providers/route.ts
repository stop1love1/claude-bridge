import { NextResponse } from "next/server";
import { detectProviders } from "@/libs/tunnels";

export const dynamic = "force-dynamic";

/**
 * GET /api/tunnels/providers
 *
 * Returns per-provider availability — used by the Tunnels page to
 * render the "ngrok needs install / needs authtoken / ready" status.
 * Always succeeds; the per-row `installed` / `installable` fields
 * encode the actual state.
 */
export function GET() {
  return NextResponse.json({ providers: detectProviders() });
}
