import { NextResponse, type NextRequest } from "next/server";
import { listPending, subscribe } from "@/libs/permissionStore";
import { isValidSessionId } from "@/libs/validate";
import { acquireSseSlot } from "@/libs/sseLimit";

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
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    start(controller) {
      const send = (event: string, data: unknown) => {
        try {
          controller.enqueue(
            encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
          );
        } catch { }
      };

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

      const ka = setInterval(() => {
        try { controller.enqueue(encoder.encode(`: keepalive\n\n`)); } catch { }
      }, 15000);

      const close = () => {
        unsub();
        clearInterval(ka);
        try { controller.close(); } catch { }
        try { releaseSlot(); } catch { }
      };

      req.signal.addEventListener("abort", close);
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      "connection": "keep-alive",
      "x-accel-buffering": "no",
    },
  });
}
