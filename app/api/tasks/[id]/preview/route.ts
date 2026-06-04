import { NextResponse, type NextRequest } from "next/server";
import { join } from "node:path";
import { SESSIONS_DIR } from "@/libs/paths";
import { readMeta } from "@/libs/meta";
import { getPreviewUrl, setPreviewUrl } from "@/libs/previewStore";
import { verifyRequestActor } from "@/libs/auth";
import { isValidTaskId } from "@/libs/tasks";
import { badRequest } from "@/libs/validate";
import { checkCsrf } from "@/libs/csrf";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

/** Resolve the task's primary app: pinned `taskApp`, else the first non-coordinator run's repo. */
function primaryApp(sessionsDir: string): string | null {
  const meta = readMeta(sessionsDir);
  if (!meta) return null;
  if (meta.taskApp && meta.taskApp.trim()) return meta.taskApp.trim();
  return meta.runs.find((r) => r.role !== "coordinator")?.repo ?? null;
}

export async function GET(_req: NextRequest, ctx: Ctx) {
  const { id } = await ctx.params;
  if (!isValidTaskId(id)) return badRequest("invalid task id");
  const app = primaryApp(join(SESSIONS_DIR, id));
  return NextResponse.json({ app, url: app ? getPreviewUrl(app) : null });
}

export async function PUT(req: NextRequest, ctx: Ctx) {
  const { id } = await ctx.params;
  if (!isValidTaskId(id)) return badRequest("invalid task id");

  const csrf = checkCsrf(req);
  if (!csrf.ok) {
    return NextResponse.json({ error: "csrf check failed", reason: csrf.reason ?? null }, { status: 403 });
  }
  // Operator-only — a guest can view (with the grant) but never set the URL.
  const actor = verifyRequestActor(req);
  if (actor?.kind !== "operator") {
    return NextResponse.json({ error: "operator only" }, { status: 403 });
  }

  const app = primaryApp(join(SESSIONS_DIR, id));
  if (!app) return NextResponse.json({ error: "task has no resolvable app yet" }, { status: 409 });

  let body: { url?: unknown };
  try { body = await req.json(); } catch { return badRequest("invalid JSON body"); }
  const url = typeof body.url === "string" ? body.url : "";
  try {
    const saved = setPreviewUrl(app, url);
    return NextResponse.json({ app, url: saved });
  } catch (e) {
    return badRequest((e as Error).message);
  }
}
