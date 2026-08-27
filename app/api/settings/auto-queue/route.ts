import { NextResponse, type NextRequest } from "next/server";
import { readAutoQueueConfig, writeAutoQueueConfig } from "@/libs/autoQueue";
import { checkCsrf } from "@/libs/csrf";
import { badRequest } from "@/libs/validate";

export const dynamic = "force-dynamic";

export function GET() {
  return NextResponse.json(readAutoQueueConfig());
}

export async function PUT(req: NextRequest) {
  const csrf = checkCsrf(req);
  if (!csrf.ok) {
    return NextResponse.json({ error: "csrf check failed", reason: csrf.reason ?? null }, { status: 403 });
  }
  let body: { enabled?: unknown; maxConcurrent?: unknown };
  try { body = await req.json(); } catch { return badRequest("invalid JSON body"); }
  const patch: { enabled?: boolean; maxConcurrent?: number } = {};
  if (typeof body.enabled === "boolean") patch.enabled = body.enabled;
  if (typeof body.maxConcurrent === "number") patch.maxConcurrent = body.maxConcurrent;
  return NextResponse.json(writeAutoQueueConfig(patch));
}
