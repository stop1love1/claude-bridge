import type { NextRequest } from "next/server";
import { join } from "node:path";
import { readMeta, subscribeMeta, type MetaChangeEvent } from "@/lib/meta";
import { SESSIONS_DIR } from "@/lib/paths";
import { isValidTaskId } from "@/lib/tasks";
import { badRequest } from "@/lib/validate";
import { subscribeSession, type StatusEvent } from "@/lib/sessionEvents";

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
      // Per-child status subscriptions. We attach one for every run
      // already in meta.json at connect time, plus one for every
      // newly-spawned run we see via the meta event stream. Cleanup
      // tears them all down on close().
      const childStatusUnsubs = new Map<string, () => void>();

      const close = () => {
        if (closed) return;
        closed = true;
        if (unsub) {
          try { unsub(); } catch { /* ignore */ }
          unsub = null;
        }
        for (const [, off] of childStatusUnsubs) {
          try { off(); } catch { /* ignore */ }
        }
        childStatusUnsubs.clear();
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

      /**
       * Forward per-child stream-json status (`thinking` / `running:
       * <tool description>` / `idle`) as a `child-status` SSE event
       * scoped to this task. The child's status is already routed
       * through `lib/sessionEvents` by the spawn parser; we just
       * fan it out to per-task subscribers so the UI can render
       * "coder is running git status" mid-task instead of waiting
       * for the final report.
       */
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

      // Initial snapshot — UI doesn't need a separate /meta fetch.
      const snap = readMeta(sessionsDir);
      if (snap) {
        send("snapshot", snap);
        // Wire status fan-out for every run already in meta.json.
        // Done runs also get a subscription: a re-spawned retry on
        // the same sessionId is rare but possible, and the cost is a
        // single emitter listener that evicts on session close.
        for (const r of snap.runs) attachChildStatus(r.sessionId);
      }

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
          // New child landed in meta — wire its status stream so the UI
          // sees mid-task progress for it too.
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
