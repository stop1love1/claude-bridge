import { NextResponse, type NextRequest } from "next/server";
import { dirname } from "node:path";
import {
  getManifestDetectScanRoots,
  setManifestDetectScanRoots,
} from "@/libs/apps";
import { BRIDGE_ROOT } from "@/libs/paths";

export const dynamic = "force-dynamic";

export function GET() {
  const saved = getManifestDetectScanRoots();
  return NextResponse.json({
    roots: saved,
    defaultRoot: dirname(BRIDGE_ROOT),
  });
}

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
