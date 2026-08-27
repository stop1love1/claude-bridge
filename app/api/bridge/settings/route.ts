import { NextResponse, type NextRequest } from "next/server";
import {
  getManifestPublicUrl,
  setManifestPublicUrl,
} from "@/libs/apps";

export const dynamic = "force-dynamic";

interface BridgeSettingsPatchBody {
  publicUrl?: string;
}

export function GET() {
  return NextResponse.json({
    publicUrl: getManifestPublicUrl(),
  });
}

export async function PUT(req: NextRequest) {
  let body: BridgeSettingsPatchBody;
  try {
    body = (await req.json()) as BridgeSettingsPatchBody;
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  if (typeof body.publicUrl === "string") {
    const trimmed = body.publicUrl.trim();
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
