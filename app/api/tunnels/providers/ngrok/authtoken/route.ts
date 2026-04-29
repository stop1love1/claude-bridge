import { NextResponse, type NextRequest } from "next/server";
import { detectProviders, setNgrokAuthtoken } from "@/libs/tunnels";

export const dynamic = "force-dynamic";

interface PutBody {
  authtoken?: unknown;
}

/**
 * PUT /api/tunnels/providers/ngrok/authtoken
 *
 * Body: `{ authtoken: string }`. Empty string clears the token.
 * Persists to `bridge.json#tunnels.ngrok.authtoken` (mode 0600). The
 * response echoes the current provider statuses so the UI can refresh
 * the ngrok row in one round-trip.
 */
export async function PUT(req: NextRequest) {
  let body: PutBody;
  try {
    body = (await req.json()) as PutBody;
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  if (typeof body.authtoken !== "string") {
    return NextResponse.json(
      { error: "authtoken must be a string (use \"\" to clear)" },
      { status: 400 },
    );
  }
  setNgrokAuthtoken(body.authtoken);
  return NextResponse.json({ providers: detectProviders() });
}
