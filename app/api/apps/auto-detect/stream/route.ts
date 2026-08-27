import type { NextRequest } from "next/server";
import { detectAppCandidates, type DetectEvent } from "@/libs/apps";
import { acquireSseSlot } from "@/libs/sseLimit";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const releaseSlot = acquireSseSlot(req);
  if (!releaseSlot) {
    return new Response("too many concurrent streams", { status: 429 });
  }
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
          closed = true;
        }
      };
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
          try { controller.close(); } catch { }
        }
        try { releaseSlot(); } catch { }
      }
    },
    cancel() {
      try { releaseSlot(); } catch { }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
