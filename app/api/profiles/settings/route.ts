import { NextResponse, type NextRequest } from "next/server";
import {
  getManifestProfileSource,
  setManifestProfileSource,
  type ProfileManifestSource,
} from "@/libs/apps";
import { badRequest } from "@/libs/validate";

export const dynamic = "force-dynamic";

export function GET() {
  return NextResponse.json({ source: getManifestProfileSource() });
}

export async function PUT(req: NextRequest) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return badRequest("invalid JSON body");
  }
  // `null`, arrays and primitives parse as valid JSON but are not a body.
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return badRequest("body must be a JSON object");
  }

  const source = (body as { source?: unknown }).source;
  if (source !== "llm" && source !== "heuristic") {
    return badRequest("source must be one of: heuristic, llm");
  }
  setManifestProfileSource(source as ProfileManifestSource);
  return NextResponse.json({ source });
}
