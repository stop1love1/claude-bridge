import type { NextRequest } from "next/server";
import { join } from "node:path";
import { readMeta, subscribeMeta, type MetaChangeEvent } from "@/lib/meta";
import { SESSIONS_DIR } from "@/lib/paths";
import { isValidTaskId } from "@/lib/tasks";
import { badRequest } from "@/lib/validate";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/**
 * Per-task lifecycle SSE. Fires once on connect with `snapshot` (the
 * full meta.json), then re-emits a row every time meta.json mutates:
 *
 *   - `event: snapshot`  data: <full Meta>
 *   - `event: spawned`   data: { sessionId, run }
 *   - `event: done`      data: { sessionId, run, prevStatus }
 *   - `event: failed`    data: { sessionId, run, prevStatus }
 *   - `event: retried`   data: { sessionId, retryOf, run }   (Phase D auto-retry)
 *   - `event: updated`   data: { sessionId, run }       (non-status patch)
 *   - `event: meta`      data: <full Meta>              (writeMeta, e.g. title edit)
 *
 * The UI (Phase C TaskDetail page) replaces its 1.5s polling loop with
 * this — it still keeps a slow polling fallback in case the dev server
 * drops the stream on HMR.
 *
 * Keepalive every 15s; cleanup on `req.signal.abort` mirrors the
 * permission-stream route.
 */
export async function GET(req: NextRequest, ctx: Ctx) {
  const { id } = await ctx.params;
  if (!isValidTaskId(id)) return badRequest("invalid task id");
  const sessionsDir = join(SESSIONS_DIR, id);
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    start(controller) {
      // `closed` is the single source of truth for "tear everything
      // down". Set true on either an enqueue throw (client TCP RST
      // before req.signal.abort fires) or the abort signal itself.
      // Without it the keepalive setInterval kept ticking forever
      // into a wedged controller, leaking both the timer AND the
      // subscribeMeta listener — that's the unbounded zombie.
      let closed = false;
      let ka: ReturnType<typeof setInterval> | null = null;
      let unsub: (() => void) | null = null;

      const close = () => {
        if (closed) return;
        closed = true;
        if (unsub) {
          try { unsub(); } catch { /* ignore */ }
          unsub = null;
        }
        if (ka !== null) {
          clearInterval(ka);
          ka = null;
        }
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      };

      const send = (event: string, data: unknown) => {
        if (closed) return;
        try {
          controller.enqueue(
            encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
          );
        } catch {
          // Enqueue threw → controller is wedged or the client RST'd
          // before signal.abort propagated. Tear down NOW; otherwise
          // ka + unsub would leak.
          close();
        }
      };

      // Initial snapshot — UI doesn't need a separate /meta fetch.
      const snap = readMeta(sessionsDir);
      if (snap) send("snapshot", snap);

      // Helper: piggyback the full Meta snapshot onto every lifecycle
       // event so the client never needs a follow-up `GET /api/tasks/<id>`
       // round-trip just to see the new meta state. The previous shape
       // (event payload = `{ sessionId, run }`) forced the UI to refetch
       // for the rest of the runs[] array.
      const sendWithMeta = (event: string, payload: Record<string, unknown>) => {
        const meta = readMeta(sessionsDir);
        send(event, { ...payload, meta });
      };

      unsub = subscribeMeta(id, (ev: MetaChangeEvent) => {
        if (closed) return;
        if (ev.kind === "spawned") {
          sendWithMeta("spawned", { sessionId: ev.sessionId, run: ev.run });
          return;
        }
        if (ev.kind === "retried") {
          sendWithMeta("retried", {
            sessionId: ev.sessionId,
            retryOf: ev.retryOf,
            run: ev.run,
          });
          return;
        }
        if (ev.kind === "transition") {
          // We only care about terminal transitions out of `running`.
          // The initial appendRun is the spawn event; never re-emit
          // "running" here.
          const next = ev.run?.status;
          if (
            ev.prevStatus === "running" &&
            (next === "done" || next === "failed" || next === "stale")
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
          // Whole-file rewrite (e.g. task title edit). Push a fresh
          // snapshot so clients can re-render headers without polling.
          const meta = readMeta(sessionsDir);
          if (meta) send("meta", meta);
        }
      });

      ka = setInterval(() => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`: keepalive\n\n`));
        } catch {
          // Same teardown rule as `send` — a wedged controller means
          // tear everything down rather than keep ticking forever.
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
