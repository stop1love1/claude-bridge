import { NextResponse } from "next/server";
import { listRoles } from "@/libs/roleRegistry";
import { serverError } from "@/libs/errorResponse";

export const dynamic = "force-dynamic";

// GET /api/bridge/roles — the role registry the plan gate and the `/agents`
// dispatch route both read. Lets the UI and coordinator see, per role, whether
// it is treated as mutating and which CLI tools the bridge denies at spawn.
export function GET() {
  try {
    return NextResponse.json({ roles: listRoles() });
  } catch (err) {
    return NextResponse.json(serverError(err, "bridge:roles"), { status: 500 });
  }
}
