import { NextResponse } from "next/server";
import { listAllPending } from "@/libs/permissionStore";

export const dynamic = "force-dynamic";

/**
 * GET: cross-session backlog of pending PreToolUse permission requests.
 *
 * The `usePermissionQueue({ all: true })` hook fetches this on mount so a
 * freshly-loaded page (or a bridge restart) immediately picks up requests
 * that arrived before its SSE subscription opened. Symmetric to the
 * per-session GET at `/api/sessions/[sessionId]/permission`.
 *
 * Returns `{ pending: PendingRequest[] }` — same shape as the per-session
 * endpoint, with the originating `sessionId` carried in each entry so the
 * client can POST the answer back to the matching per-session route.
 */
export async function GET() {
  return NextResponse.json({ pending: listAllPending() });
}
