import { NextResponse, type NextRequest } from "next/server";
import { badRequest } from "@/libs/validate";
import { ok } from "@/libs/apiResponse";
import { serverError } from "@/libs/errorResponse";
import {
  deleteShare,
  getShare,
  toShareView,
  updateShare,
  type ShareGit,
  type ShareGrants,
} from "@/libs/shareStore";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/** GET /api/share/<id> — one share (operator). */
export async function GET(_req: NextRequest, ctx: Ctx) {
  const { id } = await ctx.params;
  const share = getShare(id);
  if (!share) return NextResponse.json({ error: "share not found" }, { status: 404 });
  return ok({ share: toShareView(share) });
}

interface PatchBody {
  grants?: Partial<ShareGrants>;
  git?: Partial<ShareGit>;
  deviceTtlMs?: number | null;
  expiresAt?: number | null;
  label?: string;
  revoked?: boolean;
}

/** PATCH /api/share/<id> — edit grants / git / ttl / expiry / revoke. */
export async function PATCH(req: NextRequest, ctx: Ctx) {
  const { id } = await ctx.params;
  let body: PatchBody;
  try {
    body = (await req.json()) as PatchBody;
  } catch {
    return badRequest("invalid JSON body");
  }
  try {
    const updated = updateShare(id, {
      grants: body.grants,
      git: body.git,
      deviceTtlMs: body.deviceTtlMs,
      expiresAt: body.expiresAt,
      label: body.label,
      revoked: typeof body.revoked === "boolean" ? body.revoked : undefined,
    });
    if (!updated) return NextResponse.json({ error: "share not found" }, { status: 404 });
    return ok({ share: toShareView(updated) });
  } catch (e) {
    return NextResponse.json(serverError(e, "share:update"), { status: 500 });
  }
}

/** DELETE /api/share/<id> — remove the share entirely (hard revoke). */
export async function DELETE(_req: NextRequest, ctx: Ctx) {
  const { id } = await ctx.params;
  if (!deleteShare(id)) {
    return NextResponse.json({ error: "share not found" }, { status: 404 });
  }
  return ok();
}
