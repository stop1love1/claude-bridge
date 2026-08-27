import { NextResponse, type NextRequest } from "next/server";
import { verifyRequestAuth } from "@/libs/auth";
import { DEMO_MODE } from "@/libs/demoMode";
import { listPendingLogins } from "@/libs/loginApprovals";

export const dynamic = "force-dynamic";

export function GET(req: NextRequest) {
  if (DEMO_MODE) {
    return NextResponse.json({ error: "demo mode" }, { status: 503 });
  }
  if (!verifyRequestAuth(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const pending = listPendingLogins().map((p) => ({
    id: p.id,
    email: p.email,
    trust: p.trust,
    deviceLabel: p.deviceLabel,
    remoteIp: p.remoteIp,
    userAgent: p.userAgent,
    createdAt: p.createdAt,
    expiresAt: new Date(p.expiresAt).toISOString(),
  }));
  return NextResponse.json({ pending });
}
