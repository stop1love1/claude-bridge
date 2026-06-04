import { NextResponse, type NextRequest } from "next/server";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { SESSIONS_DIR } from "@/libs/paths";
import { readMeta, readIntake } from "@/libs/meta";
import { isValidTaskId } from "@/libs/tasks";
import { badRequest } from "@/libs/validate";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

/**
 * Intent & Planning Gate: return the task's current intake record + the
 * shared plan markdown. Read by both the operator task page and the guest
 * share page (guest authz handled by the proxy via guestAccess allowlist).
 */
export async function GET(_req: NextRequest, ctx: Ctx) {
  const { id } = await ctx.params;
  if (!isValidTaskId(id)) return badRequest("invalid task id");
  const sessionsDir = join(SESSIONS_DIR, id);
  const meta = readMeta(sessionsDir);
  if (!meta) return NextResponse.json({ error: "task not found" }, { status: 404 });

  const intake = readIntake(sessionsDir) ?? null;
  let planMarkdown: string | null = null;
  const planPath = join(sessionsDir, "plan.md");
  if (existsSync(planPath)) {
    try { planMarkdown = readFileSync(planPath, "utf8"); } catch { planMarkdown = null; }
  }
  return NextResponse.json({ intake, planMarkdown });
}
