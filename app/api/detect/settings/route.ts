import { NextResponse, type NextRequest } from "next/server";
import {
  getManifestDetectSource,
  setManifestDetectSource,
  type DetectManifestSource,
} from "@/libs/apps";

export const dynamic = "force-dynamic";

export function GET() {
  return NextResponse.json({ source: getManifestDetectSource() });
}

export async function PUT(req: NextRequest) {
  let body: { source?: unknown };
  try {
    body = (await req.json()) as { source?: unknown };
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const source = body.source;
  if (source !== "auto" && source !== "llm" && source !== "heuristic") {
    return NextResponse.json(
      { error: "source must be one of: auto, llm, heuristic" },
      { status: 400 },
    );
  }
  setManifestDetectSource(source as DetectManifestSource);
  return NextResponse.json({ source });
}
