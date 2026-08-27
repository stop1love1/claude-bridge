import { NextResponse, type NextRequest } from "next/server";
import { readConfidenceConfig, writeConfidenceConfig } from "@/libs/confidenceConfig";
import { checkCsrf } from "@/libs/csrf";
import { badRequest } from "@/libs/validate";

export const dynamic = "force-dynamic";

export function GET() {
  return NextResponse.json(readConfidenceConfig());
}

export async function PUT(req: NextRequest) {
  const csrf = checkCsrf(req);
  if (!csrf.ok) {
    return NextResponse.json({ error: "csrf check failed", reason: csrf.reason ?? null }, { status: 403 });
  }
  let body: { enabled?: unknown; threshold?: unknown; holdWorktree?: unknown };
  try { body = await req.json(); } catch { return badRequest("invalid JSON body"); }
  const patch: { enabled?: boolean; threshold?: number; holdWorktree?: boolean } = {};
  if (typeof body.enabled === "boolean") patch.enabled = body.enabled;
  if (typeof body.threshold === "number") patch.threshold = body.threshold;
  if (typeof body.holdWorktree === "boolean") patch.holdWorktree = body.holdWorktree;
  return NextResponse.json(writeConfidenceConfig(patch));
}
