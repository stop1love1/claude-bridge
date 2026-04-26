import { NextResponse, type NextRequest } from "next/server";
import {
  getManifestDetectSource,
  setManifestDetectSource,
  type DetectManifestSource,
} from "@/lib/apps";

export const dynamic = "force-dynamic";

/**
 * GET /api/detect/settings
 *
 * Returns the bridge-wide detect source setting from
 * `~/.claude/bridge.json.detect.source`. Defaults to `auto` when the
 * key is missing.
 */
export function GET() {
  return NextResponse.json({ source: getManifestDetectSource() });
}

/**
 * PUT /api/detect/settings
 *
 * Body: `{ source: "auto" | "llm" | "heuristic" }`. Persists into
 * `bridge.json` so the next task creation reads the new value.
 */
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
