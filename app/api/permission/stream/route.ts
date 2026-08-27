import type { NextRequest } from "next/server";
import { listAllPending, subscribeAll } from "@/libs/permissionStore";
import { acquireSseSlot } from "@/libs/sseLimit";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
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
        } catch {
        }
      };

      for (const p of listAllPending()) {
        send("pending", {
          sessionId: p.sessionId,
          requestId: p.requestId,
          tool: p.tool,
          input: p.input,
          createdAt: p.createdAt,
        });
      }

      const unsub = subscribeAll(
        (p) => {
          send("pending", {
            sessionId: p.sessionId,
            requestId: p.requestId,
            tool: p.tool,
            input: p.input,
            createdAt: p.createdAt,
          });
        },
        (p) => {
          send("answered", {
            sessionId: p.sessionId,
            requestId: p.requestId,
            status: p.status,
          });
        },
      );

      const ka = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(`: keepalive\n\n`));
        } catch {
        }
      }, 15000);

      let closed = false;
      const close = () => {
        if (closed) return;
        closed = true;
        try { unsub(); } catch { }
        clearInterval(ka);
        try {
          controller.close();
        } catch {
        }
        try { releaseSlot(); } catch { }
        try { req.signal.removeEventListener("abort", close); } catch { }
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
