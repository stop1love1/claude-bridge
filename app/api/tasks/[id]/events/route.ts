import type { NextRequest } from "next/server";
import { join } from "node:path";
import { readMeta, subscribeMeta, type MetaChangeEvent } from "@/lib/meta";
import { SESSIONS_DIR } from "@/lib/paths";

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
  const sessionsDir = join(SESSIONS_DIR, id);
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

      // Initial snapshot — UI doesn't need a separate /meta fetch.
      const snap = readMeta(sessionsDir);
      if (snap) send("snapshot", snap);

      const unsub = subscribeMeta(id, (ev: MetaChangeEvent) => {
        if (ev.kind === "spawned") {
          send("spawned", { sessionId: ev.sessionId, run: ev.run });
          return;
        }
        if (ev.kind === "retried") {
          send("retried", {
            sessionId: ev.sessionId,
            retryOf: ev.retryOf,
            run: ev.run,
          });
          return;
        }
        if (ev.kind === "transition") {
          // We only care about terminal transitions out of `running`.
          // The initial appendRun is the spawn event; never re-emit
          // "running" here. Other oddball transitions (queued -> running
          // when something later wires lifecycle) are silent — UI can
          // refresh meta if it cares.
          const next = ev.run?.status;
          if (
            ev.prevStatus === "running" &&
            (next === "done" || next === "failed" || next === "stale")
          ) {
            send(next, { sessionId: ev.sessionId, run: ev.run, prevStatus: ev.prevStatus });
          }
          return;
        }
        if (ev.kind === "updated") {
          send("updated", { sessionId: ev.sessionId, run: ev.run });
          return;
        }
        if (ev.kind === "writeMeta") {
          // Whole-file rewrite (e.g. task title edit). Push a fresh
          // snapshot so clients can re-render headers without polling.
          const meta = readMeta(sessionsDir);
          if (meta) send("meta", meta);
        }
      });

      const ka = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(`: keepalive\n\n`));
        } catch {
          /* ignore */
        }
      }, 15000);

      const close = () => {
        unsub();
        clearInterval(ka);
        try {
          controller.close();
        } catch {
          /* already closed */
        }
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
