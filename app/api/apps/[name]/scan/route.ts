import { NextResponse, type NextRequest } from "next/server";
import { existsSync } from "node:fs";
import { getApp, isValidAppName, updateAppDescription } from "@/libs/apps";
import { scanAppWithClaude } from "@/libs/scanApp";
import { getClientIp } from "@/libs/clientIp";
import { checkRateLimit } from "@/libs/rateLimit";

export const dynamic = "force-dynamic";
// Claude scans can run up to ~90s in scanApp.ts; give the route a
// matching ceiling. Default Next.js request timeout is generous, but
// some hosts cap shorter — be explicit.
export const maxDuration = 120;

/**
 * Each scan spawns `claude -p` in the app's working tree (~90s of CPU
 * + LLM cost). 3 scans per 5-minute window per IP is far above what a
 * legitimate operator needs (you scan an app once, occasionally re-
 * scan after big changes), and prevents an authenticated browser
 * context being abused to fan out child-process floods.
 */
const SCAN_WINDOW_MS = 5 * 60 * 1000;
const SCAN_LIMIT_PER_IP = 3;

/**
 * Run `claude -p` inside the app's working directory and ask the
 * model for a one-sentence description of what the project does.
 * Persist the answer back to `~/.claude/bridge.json` so the next
 * coordinator dispatch sees the better description.
 *
 * The response shape is:
 *   - 200 { ok: true,  app, scanned: true,  description: <new> }
 *   - 200 { ok: true,  app, scanned: false, description: <unchanged>, reason }
 *   - 400 { error }
 *   - 404 { error }
 */
export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ name: string }> },
) {
  const ip = getClientIp(req.headers);
  const denied = checkRateLimit("apps:scan:ip", ip, SCAN_LIMIT_PER_IP, SCAN_WINDOW_MS);
  if (denied) {
    return NextResponse.json(denied.body, { status: denied.status, headers: denied.headers });
  }
  const { name } = await ctx.params;
  if (!isValidAppName(name)) {
    return NextResponse.json({ error: "invalid app name" }, { status: 400 });
  }
  const app = getApp(name);
  if (!app) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  if (!existsSync(app.path)) {
    return NextResponse.json(
      { ok: true, app, scanned: false, description: app.description, reason: "path-missing" },
      { status: 200 },
    );
  }

  const summary = await scanAppWithClaude(app.path);
  if (!summary || summary === "(no clear purpose)") {
    return NextResponse.json(
      { ok: true, app, scanned: false, description: app.description, reason: summary ?? "scan-failed" },
      { status: 200 },
    );
  }

  const updated = updateAppDescription(name, summary);
  return NextResponse.json(
    { ok: true, app: updated ?? app, scanned: true, description: summary },
    { status: 200 },
  );
}
