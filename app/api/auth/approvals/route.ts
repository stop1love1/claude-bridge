import { NextResponse, type NextRequest } from "next/server";
import { verifyRequestAuth } from "@/lib/auth";
import { listPendingLogins } from "@/lib/loginApprovals";

export const dynamic = "force-dynamic";

/**
 * GET /api/auth/approvals
 *
 * Returns the set of currently-pending device login requests so the
 * already-signed-in operator can approve or deny them.
 *
 * NOTE: the proxy/middleware whitelists the entire `/api/auth/`
 * subtree (necessary for `/login`, `/me`, etc. to work without a
 * cookie), which means this handler MUST gate itself — otherwise an
 * unauthenticated client could list pending requests and grief them
 * via `POST /api/auth/approvals/<id> { decision: "denied" }`.
 *
 * The UI (mounted in HeaderShell) polls this every ~3s; lighter than
 * SSE for a feature that fires on the order of "a couple times a
 * day". Sensitive details (full UA) ship to the modal so the operator
 * can spot fishy requests at a glance.
 */
export function GET(req: NextRequest) {
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
