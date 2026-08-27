import { NextResponse, type NextRequest } from "next/server";
import { listPending, subscribe } from "@/libs/permissionStore";
import { isValidSessionId } from "@/libs/validate";
import { acquireSseSlot } from "@/libs/sseLimit";
import { createSseResponse } from "@/libs/sse";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ sessionId: string }> };

export async function GET(req: NextRequest, ctx: Ctx) {
  const { sessionId } = await ctx.params;
  if (!isValidSessionId(sessionId)) {
    return NextResponse.json({ error: "invalid sessionId" }, { status: 400 });
  }
  const releaseSlot = acquireSseSlot(req);
  if (!releaseSlot) {
    return new Response("too many concurrent streams", { status: 429 });
  }

  return createSseResponse({
    signal: req.signal,
    keepaliveMs: 15000,
    onStart: (send) => {
      for (const p of listPending(sessionId)) {
        send("pending", { requestId: p.requestId, tool: p.tool, input: p.input, createdAt: p.createdAt });
      }

      const unsub = subscribe(
        sessionId,
        (p) => {
          send("pending", { requestId: p.requestId, tool: p.tool, input: p.input, createdAt: p.createdAt });
        },
        (p) => {
          send("answered", { requestId: p.requestId, status: p.status });
        },
      );

      return () => {
        try { unsub(); } catch { }
        try { releaseSlot(); } catch { }
      };
    },
  });
}
