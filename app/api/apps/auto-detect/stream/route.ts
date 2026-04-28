import type { NextRequest } from "next/server";
import { detectAppCandidates, type DetectEvent } from "@/lib/apps";

export const dynamic = "force-dynamic";

/**
 * Server-Sent Events endpoint that streams auto-detect progress as the
 * scanner walks the configured roots. The browser opens an EventSource
 * against this URL with `roots` and `depth` query params; the server
 * pushes one `data: {json}\n\n` frame per event (started, scanning,
 * candidate, skipped, done), then closes the stream.
 *
 * Why a stream and not a single JSON response: scanning a wide root
 * (e.g. `~/projects`) can take a few seconds end-to-end; surfacing
 * candidates as they're found gives the operator immediate feedback
 * and lets them cancel via the `Stop` button (request abort).
 */
export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const rootsParam = url.searchParams.get("roots") ?? "";
  const depthParam = Number(url.searchParams.get("depth") ?? "1");
  const depth = Number.isFinite(depthParam) ? depthParam : 1;
  const roots = rootsParam
    .split("\n")
    .map((r) => r.trim())
    .filter((r) => r.length > 0);

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const enc = new TextEncoder();
      let closed = false;
      const send = (event: DetectEvent) => {
        if (closed) return;
        try {
          controller.enqueue(
            enc.encode(`data: ${JSON.stringify(event)}\n\n`),
          );
        } catch {
          // Controller was closed by the runtime — flag so we don't
          // keep enqueueing into the void.
          closed = true;
        }
      };
      // Initial comment frame so proxies (some reverse proxies hold
      // SSE connections back until they see bytes) start streaming
      // immediately.
      try { controller.enqueue(enc.encode(": ok\n\n")); } catch { closed = true; }

      try {
        await detectAppCandidates({
          roots: roots.length > 0 ? roots : undefined,
          depth,
          onEvent: send,
          signal: req.signal,
        });
      } catch (err) {
        if (!closed) {
          send({
            type: "done",
            candidates: 0,
            alreadyRegistered: 0,
            scanned: 0,
          });
          console.error("auto-detect/stream: scan failed", err);
        }
      } finally {
        if (!closed) {
          try { controller.close(); } catch { /* already closed */ }
        }
      }
    },
    cancel() {
      // Browser closed the EventSource — `req.signal` will already be
      // aborted, so the scan loop exits naturally on its next iteration.
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no", // disable nginx response buffering for SSE
    },
  });
}
