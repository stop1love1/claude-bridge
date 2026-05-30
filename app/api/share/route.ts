import { NextResponse, type NextRequest } from "next/server";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { isValidTaskId } from "@/libs/tasks";
import { badRequest } from "@/libs/validate";
import { ok } from "@/libs/apiResponse";
import { serverError } from "@/libs/errorResponse";
import { SESSIONS_DIR } from "@/libs/paths";
import { getPublicBridgeUrl } from "@/libs/paths";
import { checkRateLimit } from "@/libs/rateLimit";
import { getClientIp } from "@/libs/clientIp";
import {
  createShare,
  listShares,
  toShareView,
  type ShareGit,
  type ShareGrants,
} from "@/libs/shareStore";

export const dynamic = "force-dynamic";

/** Build the public share link for a freshly-created share. */
export function shareUrl(id: string, token: string): string {
  return `${getPublicBridgeUrl()}/share/${encodeURIComponent(id)}/${encodeURIComponent(token)}`;
}

/**
 * GET /api/share?taskId=<id>
 *
 * List shares (optionally for one task). Operator-only — gated by the
 * proxy (this path is NOT in the matcher's guest/public exclusion).
 */
export function GET(req: NextRequest) {
  const taskId = new URL(req.url).searchParams.get("taskId") ?? undefined;
  const shares = listShares(taskId ?? undefined).map(toShareView);
  return ok({ shares });
}

interface CreateBody {
  taskId?: unknown;
  grants?: Partial<ShareGrants>;
  git?: Partial<ShareGit>;
  deviceTtlMs?: unknown;
  expiresAt?: unknown;
  label?: unknown;
}

function parseGrants(g: Partial<ShareGrants> | undefined): ShareGrants {
  return {
    sendMessage: !!g?.sendMessage,
    spawnAgent: !!g?.spawnAgent,
    answerPermission: !!g?.answerPermission,
    commit: !!g?.commit,
    push: !!g?.push,
  };
}

function parseGit(g: Partial<ShareGit> | undefined): ShareGit {
  const branchMode =
    g?.branchMode === "fixed" || g?.branchMode === "auto-create" ? g.branchMode : "current";
  return {
    branchMode,
    branchName: typeof g?.branchName === "string" ? g.branchName : undefined,
    autoCommit: !!g?.autoCommit,
    autoPush: !!g?.autoPush,
  };
}

/** Optional non-negative integer, else null. */
function parseMaybeMs(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.floor(n);
}

/**
 * POST /api/share — create a share for a task. Returns the persisted
 * (UI-safe) record plus the link, which carries the only copy of the
 * raw token (never recoverable afterward).
 */
export async function POST(req: NextRequest) {
  const denied = checkRateLimit("share:create:ip", getClientIp(req.headers), 30, 60_000);
  if (denied) {
    return NextResponse.json(denied.body, { status: denied.status, headers: denied.headers });
  }
  let body: CreateBody;
  try {
    body = (await req.json()) as CreateBody;
  } catch {
    return badRequest("invalid JSON body");
  }
  const taskId = typeof body.taskId === "string" ? body.taskId.trim() : "";
  if (!isValidTaskId(taskId)) return badRequest("invalid taskId");
  if (!existsSync(join(SESSIONS_DIR, taskId))) {
    return NextResponse.json({ error: "task not found" }, { status: 404 });
  }
  try {
    const { share, token } = createShare({
      taskId,
      grants: parseGrants(body.grants),
      git: parseGit(body.git),
      deviceTtlMs: parseMaybeMs(body.deviceTtlMs),
      expiresAt: parseMaybeMs(body.expiresAt),
      label: typeof body.label === "string" ? body.label : undefined,
    });
    return NextResponse.json(
      { share: toShareView(share), url: shareUrl(share.id, token) },
      { status: 201 },
    );
  } catch (e) {
    return NextResponse.json(serverError(e, "share:create"), { status: 500 });
  }
}
