import { NextResponse, type NextRequest } from "next/server";
import { dirname } from "node:path";
import {
  getManifestDetectScanRoots,
  setManifestDetectScanRoots,
} from "@/lib/apps";
import { BRIDGE_ROOT } from "@/lib/paths";

export const dynamic = "force-dynamic";

/**
 * GET /api/detect/scan-roots
 *
 * Returns the operator's saved scan roots plus the implicit default
 * (`dirname(BRIDGE_ROOT)`) so the dialog can pre-fill its textarea
 * even when nothing has been persisted yet.
 */
export function GET() {
  const saved = getManifestDetectScanRoots();
  return NextResponse.json({
    roots: saved,
    defaultRoot: dirname(BRIDGE_ROOT),
  });
}

/**
 * PUT /api/detect/scan-roots
 *
 * Body: `{ roots: string[] }`. Persists into
 * `bridge.json.detect.scanRoots`. An empty array clears the field so
 * `bridge.json` stays terse for default-config operators.
 */
export async function PUT(req: NextRequest) {
  let body: { roots?: unknown };
  try {
    body = (await req.json()) as { roots?: unknown };
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  if (!Array.isArray(body.roots)) {
    return NextResponse.json({ error: "roots[] required" }, { status: 400 });
  }
  const cleaned = setManifestDetectScanRoots(
    body.roots.filter((r): r is string => typeof r === "string"),
  );
  return NextResponse.json({
    roots: cleaned,
    defaultRoot: dirname(BRIDGE_ROOT),
  });
}
