import { NextResponse, type NextRequest } from "next/server";
import { addApp, isValidAppName, loadApps } from "@/lib/apps";
import { pruneStaleWorktrees } from "@/lib/worktrees";

export const dynamic = "force-dynamic";

export async function GET() {
  const apps = loadApps();
  // P4/F1 — opportunistic worktree pruner. Runs on every apps-GET
  // (cheap; the apps page is the only thing that hits this regularly).
  // Reaps `.worktrees/*` directories older than the configured TTL
  // for any app that has worktree mode enabled. Errors per app stay
  // local — never fail the GET because of a pruner glitch.
  await Promise.all(
    apps
      .filter((a) => a.git.worktreeMode === "enabled")
      .map((a) =>
        pruneStaleWorktrees({ appPath: a.path }).catch((err) => {
          console.warn(`[worktree] prune for ${a.name} failed`, err);
          return 0;
        }),
      ),
  );
  return NextResponse.json(apps);
}

export async function POST(req: NextRequest) {
  let body: { name?: string; path?: string; description?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const name = (body.name ?? "").trim();
  const path = (body.path ?? "").trim();
  const description = (body.description ?? "").trim();

  if (!isValidAppName(name)) {
    return NextResponse.json(
      { error: "invalid app name (allowed: letters, digits, dot, dash, underscore; must start with alphanumeric)" },
      { status: 400 },
    );
  }
  if (!path) {
    return NextResponse.json({ error: "path is required" }, { status: 400 });
  }

  const result = addApp({ name, path, description });
  if (!result.ok) {
    const status = result.reason === "duplicate-name" ? 409 : 400;
    return NextResponse.json({ error: result.reason }, { status });
  }
  return NextResponse.json(result.app, { status: 201 });
}
