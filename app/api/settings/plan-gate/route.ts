import { NextResponse, type NextRequest } from "next/server";
import { readPlanGateConfig, writePlanGateConfig } from "@/libs/planGateConfig";
import { checkCsrf } from "@/libs/csrf";
import { badRequest } from "@/libs/validate";

export const dynamic = "force-dynamic";

/**
 * Operator-only config for the Intent & Planning Gate. The proxy gates
 * `/api/settings` behind the operator session cookie, so there's no extra
 * authz here — but state-changing PUT still gets the standard CSRF check.
 */
export function GET() {
  return NextResponse.json(readPlanGateConfig());
}

export async function PUT(req: NextRequest) {
  const csrf = checkCsrf(req);
  if (!csrf.ok) {
    return NextResponse.json({ error: "csrf check failed", reason: csrf.reason ?? null }, { status: 403 });
  }
  let body: { operatorEnabled?: unknown; maxClarifyRounds?: unknown };
  try { body = await req.json(); } catch { return badRequest("invalid JSON body"); }
  const patch: { operatorEnabled?: boolean; maxClarifyRounds?: number } = {};
  if (typeof body.operatorEnabled === "boolean") patch.operatorEnabled = body.operatorEnabled;
  if (typeof body.maxClarifyRounds === "number") patch.maxClarifyRounds = body.maxClarifyRounds;
  return NextResponse.json(writePlanGateConfig(patch));
}
