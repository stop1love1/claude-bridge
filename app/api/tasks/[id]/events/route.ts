import type { NextRequest } from "next/server";
import { join } from "node:path";
import { readMeta, subscribeMeta, type MetaChangeEvent } from "@/libs/meta";
import { SESSIONS_DIR } from "@/libs/paths";
import { isValidTaskId } from "@/libs/tasks";
import { badRequest } from "@/libs/validate";
import { subscribeSession, type StatusEvent } from "@/libs/sessionEvents";
import { acquireSseSlot } from "@/libs/sseLimit";
import { createSseResponse } from "@/libs/sse";

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

  return createSseResponse({
    signal: req.signal,
    keepaliveMs: 15000,
    onStart: (send) => {
      const childStatusUnsubs = new Map<string, () => void>();

      const attachChildStatus = (sessionId: string) => {
        if (childStatusUnsubs.has(sessionId)) return;
        const off = subscribeSession(sessionId, {
          onStatus: (s: StatusEvent) => {
            send("child-status", { sessionId, status: s });
          },
          onAlive: (alive: boolean) => {
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

      const unsub = subscribeMeta(id, (ev: MetaChangeEvent) => {
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

      return () => {
        try { unsub(); } catch { }
        for (const [, off] of childStatusUnsubs) {
          try { off(); } catch { }
        }
        childStatusUnsubs.clear();
        try { releaseSlot(); } catch { }
      };
    },
  });
}
