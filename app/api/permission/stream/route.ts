import type { NextRequest } from "next/server";
import { listAllPending, subscribeAll } from "@/libs/permissionStore";
import { acquireSseSlot } from "@/libs/sseLimit";
import { createSseResponse } from "@/libs/sse";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const releaseSlot = acquireSseSlot(req);
  if (!releaseSlot) {
    return new Response("too many concurrent streams", { status: 429 });
  }

  return createSseResponse({
    signal: req.signal,
    keepaliveMs: 15000,
    onStart: (send) => {
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

      return () => {
        try { unsub(); } catch { }
        try { releaseSlot(); } catch { }
      };
    },
  });
}
