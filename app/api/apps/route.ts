import { NextResponse, type NextRequest } from "next/server";
import { addApp, isValidAppName, loadApps } from "@/libs/apps";
import { pruneStaleWorktrees } from "@/libs/worktrees";
import { logWarn } from "@/libs/log";

export const dynamic = "force-dynamic";

export async function GET() {
  const apps = loadApps();
  await Promise.all(
    apps
      .filter((a) => a.git.worktreeMode === "enabled")
      .map((a) =>
        pruneStaleWorktrees({ appPath: a.path }).catch((err) => {
          logWarn("worktree", `prune for ${a.name} failed`, { error: (err as Error)?.message ?? String(err) });
          return 0;
        }),
      ),
  );
  return NextResponse.json(apps);
}

export async function POST(req: NextRequest) {
  let body: { name?: string; path?: string; description?: string; preset?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const name = (body.name ?? "").trim();
  const path = (body.path ?? "").trim();
  const description = (body.description ?? "").trim();
  const preset = body.preset === "recommended" ? "recommended" : undefined;

  if (!isValidAppName(name)) {
    return NextResponse.json(
      { error: "invalid app name (allowed: letters, digits, dot, dash, underscore; must start with alphanumeric)" },
      { status: 400 },
    );
  }
  if (!path) {
    return NextResponse.json({ error: "path is required" }, { status: 400 });
  }

  const result = addApp({ name, path, description, preset });
  if (!result.ok) {
    const status = result.reason === "duplicate-name" ? 409 : 400;
    const body: { error: string; detail?: string } = { error: result.reason };
    if (result.detail) body.detail = result.detail;
    return NextResponse.json(body, { status });
  }
  return NextResponse.json(result.app, { status: 201 });
}
