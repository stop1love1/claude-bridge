import { NextResponse, type NextRequest } from "next/server";
import { verifyRequestActor } from "@/libs/auth";
import { checkCsrf } from "@/libs/csrf";
import { checkRateLimit } from "@/libs/rateLimit";
import { getClientIp } from "@/libs/clientIp";
import {
  addSubscription,
  removeSubscription,
  type PushSubscriptionJSON,
} from "@/libs/webPush";

export const dynamic = "force-dynamic";

interface SubscribeBody {
  /** Present + valid → register/refresh this subscription. */
  subscription?: PushSubscriptionJSON;
  /** Present alongside `unsubscribe: true` → drop this endpoint. */
  endpoint?: string;
  unsubscribe?: boolean;
}

/**
 * Register or remove a browser's Web Push subscription. Same auth
 * shape as `app/api/tasks/[id]/plan/approve/route.ts`: CSRF check →
 * rate limit → actor auth. OPERATOR-ONLY: `sendPushToAll`
 * (libs/webPush.ts) fans every notification out to EVERY subscribed
 * browser — coordinator summaries, permission pings, and login-approval
 * pings (UA + IP) across ALL tasks, not just one — so letting a
 * task-scoped guest subscribe would pierce the single-task boundary
 * `libs/guestAccess.ts` otherwise enforces. `libs/guestAccess.ts`
 * already excludes this route from the guest allowlist (the proxy
 * denies a guest cookie before the request reaches here); this check is
 * the route-level backstop for anything that calls in directly.
 */
export async function POST(req: NextRequest) {
  const csrf = checkCsrf(req);
  if (!csrf.ok) {
    return NextResponse.json(
      { error: "csrf check failed", reason: csrf.reason ?? null },
      { status: 403 },
    );
  }
  const denied = checkRateLimit("push:subscribe", getClientIp(req.headers), 30, 60_000);
  if (denied) {
    return NextResponse.json(denied.body, { status: denied.status, headers: denied.headers });
  }

  const actor = verifyRequestActor(req);
  if (!actor || actor.kind !== "operator") {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let body: SubscribeBody;
  try {
    body = (await req.json()) as SubscribeBody;
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  if (body.unsubscribe) {
    if (typeof body.endpoint !== "string" || !body.endpoint) {
      return NextResponse.json({ error: "endpoint is required to unsubscribe" }, { status: 400 });
    }
    removeSubscription(body.endpoint);
    return NextResponse.json({ ok: true });
  }

  const sub = body.subscription;
  if (
    !sub ||
    typeof sub.endpoint !== "string" ||
    !sub.endpoint ||
    !sub.keys ||
    typeof sub.keys.p256dh !== "string" ||
    typeof sub.keys.auth !== "string"
  ) {
    return NextResponse.json({ error: "invalid subscription" }, { status: 400 });
  }

  addSubscription(sub);
  return NextResponse.json({ ok: true });
}
