import { NextResponse } from "next/server";
import { existsSync } from "node:fs";
import { getApp, isValidAppName, updateAppDescription } from "@/libs/apps";
import { scanAppWithClaude } from "@/libs/scanApp";

export const dynamic = "force-dynamic";
// Claude scans can run up to ~90s in scanApp.ts; give the route a
// matching ceiling. Default Next.js request timeout is generous, but
// some hosts cap shorter — be explicit.
export const maxDuration = 120;

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
  _req: Request,
  ctx: { params: Promise<{ name: string }> },
) {
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
