import { NextResponse, type NextRequest } from "next/server";
import { readUsageSnapshot } from "@/libs/usageStats";

export const dynamic = "force-dynamic";

/**
 * GET /api/usage[?force=1]
 *
 * Returns the local Claude Code stats cache (per-model token totals,
 * daily activity, longest session) + the plan tier from the OAuth
 * credentials file + the live quota panel from Anthropic's
 * `/api/oauth/usage` endpoint. See `libs/usageStats.ts` for source
 * details. Quota fetch is bounded by an internal timeout and the
 * snapshot is cached server-side (~60 s on success, ~8 s on error)
 * to avoid Anthropic's per-minute rate limit on the upstream endpoint.
 *
 * Pass `?force=1` to bypass the cache — used by the manual refresh
 * button in the UI when the operator wants the freshest numbers.
 */
export async function GET(req: NextRequest) {
  const force = new URL(req.url).searchParams.get("force") === "1";
  return NextResponse.json(await readUsageSnapshot(force));
}
