import type { NextRequest } from "next/server";
import { listAllPending, subscribeAll } from "@/libs/permissionStore";
import { acquireSseSlot } from "@/libs/sseLimit";

export const dynamic = "force-dynamic";

/**
 * Global SSE stream of pending PreToolUse permission requests across
 * every active session. Mounted via the GlobalPermissionDialog in
 * Providers so any tab — including ones that aren't watching the
 * originating session — surfaces the popup.
 *
 * Event payloads carry the originating `sessionId` so the dialog can
 * POST the answer back to `/api/sessions/<sid>/permission/<rid>`.
 *
 * 15s keepalive comment, cleanup on `req.signal.abort` — same shape as
 * the per-session permission stream.
 */
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
          /* client disconnected */
        }
      };

      // Replay the global backlog so a freshly-mounted dialog catches
      // anything that was announced before the SSE connect landed.
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
          /* ignore */
        }
      }, 15000);

      let closed = false;
      const close = () => {
        if (closed) return;
        closed = true;
        try { unsub(); } catch { /* ignore */ }
        clearInterval(ka);
        try {
          controller.close();
        } catch {
          /* already closed */
        }
        try { releaseSlot(); } catch { /* idempotent */ }
        // Remove the abort listener so a Next.js framework that retains
        // the request object beyond the stream's lifetime doesn't keep
        // a dangling reference to this closure.
        try { req.signal.removeEventListener("abort", close); } catch { /* ignore */ }
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
