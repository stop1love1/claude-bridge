import type { NextRequest } from "next/server";
import { join } from "node:path";
import { readMeta, subscribeMeta, type MetaChangeEvent } from "@/libs/meta";
import { SESSIONS_DIR } from "@/libs/paths";
import { isValidTaskId } from "@/libs/tasks";
import { badRequest } from "@/libs/validate";
import { subscribeSession, type StatusEvent } from "@/libs/sessionEvents";
import { acquireSseSlot } from "@/libs/sseLimit";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(req: NextRequest, ctx: Ctx) {
  const { id } = await ctx.params;
  if (!isValidTaskId(id)) return badRequest("invalid task id");
  const releaseSlot = acquireSseSlot(req);
  if (!releaseSlot) {
    return new Response("too many concurrent streams", { status: 429 });
  }
  const sessionsDir = join(SESSIONS_DIR, id);
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    start(controller) {
      let closed = false;
      let ka: ReturnType<typeof setInterval> | null = null;
      let unsub: (() => void) | null = null;
      const childStatusUnsubs = new Map<string, () => void>();

      const close = () => {
        if (closed) return;
        closed = true;
        if (unsub) {
          try { unsub(); } catch { }
          unsub = null;
        }
        for (const [, off] of childStatusUnsubs) {
          try { off(); } catch { }
        }
        childStatusUnsubs.clear();
        if (ka !== null) {
          clearInterval(ka);
          ka = null;
        }
        try {
          controller.close();
        } catch {
        }
        try { releaseSlot(); } catch { }
      };

      const send = (event: string, data: unknown) => {
        if (closed) return;
        try {
          controller.enqueue(
            encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
          );
        } catch {
          close();
        }
      };

      const attachChildStatus = (sessionId: string) => {
        if (childStatusUnsubs.has(sessionId)) return;
        const off = subscribeSession(sessionId, {
          onStatus: (s: StatusEvent) => {
            if (closed) return;
            send("child-status", { sessionId, status: s });
          },
          onAlive: (alive: boolean) => {
            if (closed) return;
            send("child-alive", { sessionId, alive });
          },
        });
        childStatusUnsubs.set(sessionId, off);
      };

      const snap = readMeta(sessionsDir);
      if (snap) {
        send("snapshot", snap);
        for (const r of snap.runs) attachChildStatus(r.sessionId);
      }

      const sendWithMeta = (event: string, payload: Record<string, unknown>) => {
        const meta = readMeta(sessionsDir);
        send(event, { ...payload, meta });
      };

      unsub = subscribeMeta(id, (ev: MetaChangeEvent) => {
        if (closed) return;
        if (ev.kind === "spawned") {
          if (ev.sessionId) attachChildStatus(ev.sessionId);
          sendWithMeta("spawned", { sessionId: ev.sessionId, run: ev.run });
          return;
        }
        if (ev.kind === "retried") {
          if (ev.sessionId) attachChildStatus(ev.sessionId);
          sendWithMeta("retried", {
            sessionId: ev.sessionId,
            retryOf: ev.retryOf,
            run: ev.run,
          });
          return;
        }
        if (ev.kind === "transition") {
          const next = ev.run?.status;
          if (
            ev.prevStatus === "running" &&
            (next === "done" || next === "failed" || next === "cancelled" || next === "stale")
          ) {
            sendWithMeta(next, { sessionId: ev.sessionId, run: ev.run, prevStatus: ev.prevStatus });
          }
          return;
        }
        if (ev.kind === "updated") {
          sendWithMeta("updated", { sessionId: ev.sessionId, run: ev.run });
          return;
        }
        if (ev.kind === "writeMeta") {
          const meta = readMeta(sessionsDir);
          if (meta) send("meta", meta);
        }
      });

      ka = setInterval(() => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`: keepalive\n\n`));
        } catch {
          close();
        }
      }, 15000);

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
