import { NextResponse, type NextRequest } from "next/server";
import { listRoles } from "@/libs/roleRegistry";
import {
  createCustomRole,
  deleteCustomRole,
  listCustomRoles,
  updateCustomRole,
  type RoleWriteResult,
} from "@/libs/roleStore";
import { serverError } from "@/libs/errorResponse";
import { badRequest } from "@/libs/validate";

export const dynamic = "force-dynamic";

/**
 * `null`, arrays and primitives all parse as valid JSON but are not a body;
 * reading a field off them is how a route ends up returning 500 for what is
 * really a client mistake (see the `/api/tasks/<id>/wait` fix).
 */
async function readObjectBody(
  req: NextRequest,
): Promise<{ ok: true; body: Record<string, unknown> } | { ok: false; res: NextResponse }> {
  let parsed: unknown;
  try {
    parsed = await req.json();
  } catch {
    return { ok: false, res: badRequest("invalid JSON body") };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, res: badRequest("body must be a JSON object") };
  }
  return { ok: true, body: parsed as Record<string, unknown> };
}

function fromWrite(result: RoleWriteResult): NextResponse {
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status });
  }
  return NextResponse.json({ role: result.role, roles: listRoles(), custom: listCustomRoles() });
}

// GET /api/bridge/roles — the role registry the plan gate and the `/agents`
// dispatch route both read. Lets the UI and coordinator see, per role, whether
// it is treated as mutating and which CLI tools the bridge denies at spawn.
// `custom` carries the editable overlay only (built-ins are not editable).
export function GET() {
  try {
    return NextResponse.json({ roles: listRoles(), custom: listCustomRoles() });
  } catch (err) {
    return NextResponse.json(serverError(err, "bridge:roles"), { status: 500 });
  }
}

// POST — create one custom role.
export async function POST(req: NextRequest) {
  const parsed = await readObjectBody(req);
  if (!parsed.ok) return parsed.res;
  const b = parsed.body;
  try {
    return fromWrite(
      createCustomRole({
        name: typeof b.name === "string" ? b.name : "",
        mutating: b.mutating as boolean,
        description: b.description as string | undefined,
        disallowedTools: b.disallowedTools as string[] | undefined,
        playbook: b.playbook as string | null | undefined,
      }),
    );
  } catch (err) {
    return NextResponse.json(serverError(err, "bridge:roles:create"), { status: 500 });
  }
}

// PATCH — update one custom role, identified by `name` in the body. The name
// itself is immutable: renaming would silently orphan every run already
// dispatched under the old label, so a rename is a delete plus a create.
export async function PATCH(req: NextRequest) {
  const parsed = await readObjectBody(req);
  if (!parsed.ok) return parsed.res;
  const b = parsed.body;
  if (typeof b.name !== "string" || !b.name.trim()) {
    return badRequest("name is required");
  }
  try {
    return fromWrite(
      updateCustomRole(b.name, {
        mutating: b.mutating as boolean | undefined,
        description: b.description as string | undefined,
        disallowedTools: b.disallowedTools as string[] | undefined,
        playbook: b.playbook as string | null | undefined,
      }),
    );
  } catch (err) {
    return NextResponse.json(serverError(err, "bridge:roles:update"), { status: 500 });
  }
}

// DELETE /api/bridge/roles?name=<role> — remove one custom role. Built-ins are
// not in the overlay, so they simply come back 404.
export function DELETE(req: NextRequest) {
  const name = req.nextUrl.searchParams.get("name")?.trim() ?? "";
  if (!name) return badRequest("name query param is required");
  try {
    if (!deleteCustomRole(name)) {
      return NextResponse.json({ error: `role "${name}" not found` }, { status: 404 });
    }
    return NextResponse.json({ ok: true, roles: listRoles(), custom: listCustomRoles() });
  } catch (err) {
    return NextResponse.json(serverError(err, "bridge:roles:delete"), { status: 500 });
  }
}
