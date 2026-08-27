import { NextResponse, type NextRequest } from "next/server";
import { announcePending, listPending } from "@/libs/permissionStore";
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
  return ok();
}

export async function GET(_req: NextRequest, ctx: Ctx) {
  const { sessionId } = await ctx.params;
  if (!isValidSessionId(sessionId)) return badRequest("invalid sessionId");
  return NextResponse.json({ pending: listPending(sessionId) });
}
