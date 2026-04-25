import { NextResponse, type NextRequest } from "next/server";
import { announcePending, listPending } from "@/lib/permissionStore";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ sessionId: string }> };

interface AnnounceBody {
  requestId: string;
  tool: string;
  input?: unknown;
  timestamp?: string;
}

/**
 * POST: called by `agents/permission-hook.cjs` before every tool call.
 * The hook hands us a fresh requestId + tool metadata; we stash it as
 * `pending` and notify any UI subscribed to this session's stream so
 * the user sees a popup. Returns immediately — the hook then long-polls
 * `[requestId]/route.ts` for the answer.
 */
export async function POST(req: NextRequest, ctx: Ctx) {
  const { sessionId } = await ctx.params;
  const body = (await req.json()) as Partial<AnnounceBody>;
  if (!body.requestId || !body.tool) {
    return NextResponse.json(
      { error: "requestId and tool are required" },
      { status: 400 },
    );
  }
  announcePending({
    sessionId,
    requestId: body.requestId,
    tool: body.tool,
    input: body.input ?? {},
    createdAt: body.timestamp ?? new Date().toISOString(),
  });
  return NextResponse.json({ ok: true });
}

/**
 * GET: optional — UI calls this when it mounts to render any backlog
 * of pending requests it might have missed before its SSE subscription
 * connected. Filters out already-answered records.
 */
export async function GET(_req: NextRequest, ctx: Ctx) {
  const { sessionId } = await ctx.params;
  return NextResponse.json({ pending: listPending(sessionId) });
}
