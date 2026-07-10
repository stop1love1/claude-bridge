import { NextResponse } from "next/server";
import { ensureVapidKeys } from "@/libs/webPush";

export const dynamic = "force-dynamic";

/**
 * Hand the browser the VAPID public key it needs to build a
 * `PushManager.subscribe({ applicationServerKey, ... })` call.
 *
 * GET-only and read-only, so no CSRF check is needed (see
 * `libs/csrf.ts` — safe methods are always allowed) — cookie auth is
 * still enforced globally by `proxy.ts` for every non-public API path,
 * operator or guest alike. The public key isn't secret (it's designed
 * to be shipped to the browser), but gating it behind auth anyway keeps
 * the route consistent with the rest of the API surface and avoids
 * leaking "this bridge has push configured" to an unauthenticated probe.
 */
export async function GET() {
  const { publicKey } = ensureVapidKeys();
  return NextResponse.json({ publicKey });
}
