import { NextResponse, type NextRequest } from "next/server";
import { listRoles } from "@/libs/roleRegistry";
import { exportRoleBundle, importRoleBundle, listCustomRoles } from "@/libs/roleStore";
import { serverError } from "@/libs/errorResponse";
import { badRequest } from "@/libs/validate";

export const dynamic = "force-dynamic";

/**
 * Packaging for custom roles: the whole overlay in one JSON file, so a role
 * set can be moved between machines (or checked into a repo) without hand-
 * editing `.bridge-state/roles.json`.
 *
 * GET  → the bundle. POST → import it back.
 */
export function GET() {
  try {
    return NextResponse.json(exportRoleBundle(), {
      headers: {
        "content-disposition": 'attachment; filename="bridge-roles.json"',
      },
    });
  } catch (err) {
    return NextResponse.json(serverError(err, "bridge:roles:export"), { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  let parsed: unknown;
  try {
    parsed = await req.json();
  } catch {
    return badRequest("invalid JSON body");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return badRequest("body must be a JSON object");
  }
  const body = parsed as Record<string, unknown>;
  const mode = body.mode === undefined ? "merge" : body.mode;
  if (mode !== "merge" && mode !== "replace") {
    return badRequest("mode must be one of: merge, replace");
  }
  // The bundle may arrive wrapped (`{ bundle: {...} }`, what the UI sends after
  // reading a file) or as the exported envelope itself.
  const bundle = body.bundle !== undefined ? body.bundle : body;
  if (!bundle || typeof bundle !== "object") {
    return badRequest("bundle must be a JSON object");
  }
  if (!Array.isArray((bundle as { roles?: unknown }).roles)) {
    return badRequest("bundle.roles must be an array");
  }
  try {
    const { imported, replaced, skipped } = importRoleBundle(bundle, mode);
    return NextResponse.json({
      imported,
      replaced,
      skipped,
      roles: listRoles(),
      custom: listCustomRoles(),
    });
  } catch (err) {
    return NextResponse.json(serverError(err, "bridge:roles:import"), { status: 500 });
  }
}
