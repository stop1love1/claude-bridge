import { type NextRequest } from "next/server";
import { ok } from "@/libs/apiResponse";
import { listPendingShareRequests } from "@/libs/shareApprovals";
import { getShare } from "@/libs/shareStore";

export const dynamic = "force-dynamic";

export function GET(_req: NextRequest) {
  const pending = listPendingShareRequests().map((r) => {
    const share = getShare(r.shareId);
    return {
      id: r.id,
      shareId: r.shareId,
      taskId: r.taskId,
      displayName: r.displayName,
      ip: r.ip,
      userAgent: r.userAgent,
      createdAt: r.createdAt,
      expiresAt: new Date(r.expiresAt).toISOString(),
      shareLabel: share?.label ?? null,
      grants: share?.grants ?? null,
    };
  });
  return ok({ pending });
}
