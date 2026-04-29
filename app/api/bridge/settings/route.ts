import { NextResponse, type NextRequest } from "next/server";
import {
  getManifestPublicUrl,
  setManifestPublicUrl,
} from "@/libs/apps";

export const dynamic = "force-dynamic";

interface BridgeSettingsPatchBody {
  publicUrl?: string;
}

/**
 * GET /api/bridge/settings
 *
 * Returns the bridge-level settings stored at the top of `bridge.json`
 * (currently just `publicUrl` — the operator-configured public origin
 * the bridge is reachable at after deploy). Distinct from
 * `/api/telegram/settings` and `/api/apps/...` so each section of the
 * manifest has its own narrow surface.
 */
export function GET() {
  return NextResponse.json({
    publicUrl: getManifestPublicUrl(),
  });
}

/**
 * PUT /api/bridge/settings
 *
 * Body: `{ publicUrl?: string }`. An empty string clears the field;
 * a non-empty string is normalized through `setManifestPublicUrl` —
 * which strips path/query/hash, requires http/https protocol, and
 * returns the resulting origin. Pasted garbage is rejected with 400 so
 * the UI can surface a clear error instead of silently dropping it.
 */
export async function PUT(req: NextRequest) {
  let body: BridgeSettingsPatchBody;
  try {
    body = (await req.json()) as BridgeSettingsPatchBody;
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  if (typeof body.publicUrl === "string") {
    const trimmed = body.publicUrl.trim();
    // Empty = clear; non-empty MUST parse as http/https URL.
    if (trimmed) {
      try {
        const parsed = new URL(trimmed);
        if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
          return NextResponse.json(
            { error: "publicUrl must use http:// or https://" },
            { status: 400 },
          );
        }
      } catch {
        return NextResponse.json(
          { error: "publicUrl is not a valid URL" },
          { status: 400 },
        );
      }
    }
    setManifestPublicUrl(body.publicUrl);
  }

  return NextResponse.json({
    publicUrl: getManifestPublicUrl(),
  });
}
