import { NextResponse, type NextRequest } from "next/server";
import { touchPresence, listActive } from "@/libs/presenceStore";
import { verifyRequestActor } from "@/libs/auth";
import { isValidTaskId } from "@/libs/tasks";
import { badRequest } from "@/libs/validate";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

/** UI-safe projection — never leaks `lastSeen` timestamps. */
function project(taskId: string) {
  return {
    active: listActive(taskId).map((p) => ({ id: p.id, label: p.label, kind: p.kind })),
  };
}

export async function GET(_req: NextRequest, ctx: Ctx) {
  const { id } = await ctx.params;
  if (!isValidTaskId(id)) return badRequest("invalid task id");
  return NextResponse.json(project(id));
}

/**
 * Heartbeat. Identity is server-derived (operator vs guest did) so a guest
 * can't impersonate another participant; the body `label` is display-only.
 */
export async function POST(req: NextRequest, ctx: Ctx) {
  const { id } = await ctx.params;
  if (!isValidTaskId(id)) return badRequest("invalid task id");

  const actor = verifyRequestActor(req);
  if (!actor) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  let body: { label?: unknown } = {};
  try { body = (await req.json()) as { label?: unknown }; } catch { /* label optional */ }
  const rawLabel = typeof body.label === "string" ? body.label : "";

  if (actor.kind === "operator") {
    touchPresence(id, { id: "operator", label: rawLabel || "Operator", kind: "operator" });
  } else {
    touchPresence(id, {
      id: actor.did,
      label: rawLabel || `guest-${actor.did.slice(0, 6)}`,
      kind: "guest",
    });
  }
  return NextResponse.json(project(id));
}
