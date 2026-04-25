import type { NextRequest } from "next/server";
import { listPending, subscribe } from "@/lib/permissionStore";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ sessionId: string }> };

/**
 * SSE stream of pending PreToolUse permission requests for one session.
 *
 * The UI connects on mount, receives any backlog as `pending` events,
 * then listens for new ones. A 15s `keepalive` comment keeps proxies /
 * Next dev server from reaping the connection.
 */
export async function GET(req: NextRequest, ctx: Ctx) {
  const { sessionId } = await ctx.params;
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    start(controller) {
      const send = (event: string, data: unknown) => {
        try {
          controller.enqueue(
            encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
          );
        } catch { /* client disconnected */ }
      };

      // Replay backlog so a freshly-mounted UI sees pending items
      // even if the announce POST landed before the stream opened.
      for (const p of listPending(sessionId)) {
        send("pending", { requestId: p.requestId, tool: p.tool, input: p.input, createdAt: p.createdAt });
      }

      const unsub = subscribe(
        sessionId,
        (p) => {
          send("pending", { requestId: p.requestId, tool: p.tool, input: p.input, createdAt: p.createdAt });
        },
        (p) => {
          // Tell every other subscriber (extra tab, refreshed window) to
          // drop this request from its local queue — the user already
          // answered it from another window.
          send("answered", { requestId: p.requestId, status: p.status });
        },
      );

      const ka = setInterval(() => {
        try { controller.enqueue(encoder.encode(`: keepalive\n\n`)); } catch { /* ignore */ }
      }, 15000);

      const close = () => {
        unsub();
        clearInterval(ka);
        try { controller.close(); } catch { /* already closed */ }
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
