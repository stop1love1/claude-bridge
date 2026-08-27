import { NextResponse, type NextRequest } from "next/server";
import { existsSync } from "node:fs";
import { backfillAppVerifyIfEmpty, resolveAppFromRouteSegment, updateAppDescription } from "@/libs/apps";
import { scanAppWithClaude } from "@/libs/scanApp";
import { getClientIp } from "@/libs/clientIp";
import { checkRateLimit } from "@/libs/rateLimit";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

const SCAN_WINDOW_MS = 5 * 60 * 1000;
const SCAN_LIMIT_PER_IP = 3;

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ name: string }> },
) {
  const ip = getClientIp(req.headers);
  const denied = checkRateLimit("apps:scan:ip", ip, SCAN_LIMIT_PER_IP, SCAN_WINDOW_MS);
  if (denied) {
    return NextResponse.json(denied.body, { status: denied.status, headers: denied.headers });
  }
  const { name: segment } = await ctx.params;
  const app = resolveAppFromRouteSegment(segment);
  if (!app) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  if (!existsSync(app.path)) {
    return NextResponse.json(
      { ok: true, app, scanned: false, description: app.description, reason: "path-missing" },
      { status: 200 },
    );
  }

  const verifyBackfilled = backfillAppVerifyIfEmpty(app.name) ?? app;

  const summary = await scanAppWithClaude(app.path);
  if (!summary || summary === "(no clear purpose)") {
    return NextResponse.json(
      {
        ok: true,
        app: verifyBackfilled,
        scanned: false,
        description: verifyBackfilled.description,
        reason: summary ?? "scan-failed",
      },
      { status: 200 },
    );
  }

  const updated = updateAppDescription(app.name, summary);
  return NextResponse.json(
    { ok: true, app: updated ?? verifyBackfilled, scanned: true, description: summary },
    { status: 200 },
  );
}
