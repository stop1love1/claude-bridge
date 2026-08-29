import { NextResponse, type NextRequest } from "next/server";
import { announcePending, answer, listPending } from "@/libs/permissionStore";
import { isSessionBypassed } from "@/libs/sessionBypass";
import {
  badRequest,
  isValidRequestId,
  isValidSessionId,
  isValidToolName,
} from "@/libs/validate";
import { ok } from "@/libs/apiResponse";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ sessionId: string }> };

interface AnnounceBody {
  requestId: string;
  tool: string;
  input?: unknown;
  timestamp?: string;
}

export async function POST(req: NextRequest, ctx: Ctx) {
  const { sessionId } = await ctx.params;
  if (!isValidSessionId(sessionId)) return badRequest("invalid sessionId");

  const body = (await req.json()) as Partial<AnnounceBody>;
  if (!body.requestId || !body.tool) {
    return NextResponse.json(
      { error: "requestId and tool are required" },
      { status: 400 },
    );
  }
  if (!isValidRequestId(body.requestId)) return badRequest("invalid requestId");
  if (!isValidToolName(body.tool)) return badRequest("invalid tool");

  announcePending({
    sessionId,
    requestId: body.requestId,
    tool: body.tool,
    input: body.input ?? {},
    createdAt: body.timestamp ?? new Date().toISOString(),
  });

  // Skip-permissions is a per-session choice the operator makes in the
  // composer. Answering here is what makes it apply to a turn that is already
  // running and to sessions the bridge did not spawn — the hook long-polls for
  // this decision, so it proceeds without ever drawing a popup.
  if (isSessionBypassed(sessionId)) {
    answer(sessionId, body.requestId, "allow", "auto-allowed: skip permissions");
  }
  return ok();
}

export async function GET(_req: NextRequest, ctx: Ctx) {
  const { sessionId } = await ctx.params;
  if (!isValidSessionId(sessionId)) return badRequest("invalid sessionId");
  return NextResponse.json({ pending: listPending(sessionId) });
}
