import type { NextRequest } from "next/server";
import { existsSync, watch, type FSWatcher } from "node:fs";
import { join } from "node:path";
import { resolveSessionFile, tailJsonl } from "@/libs/sessions";
import { isAlive, subscribeSession, type PartialEvent, type StatusEvent } from "@/libs/sessionEvents";
import { isRegisteredRepoPath } from "@/libs/sessionAccess";
import { acquireSseSlot } from "@/libs/sseLimit";
import { verifyRequestActor } from "@/libs/auth";
import { readMeta } from "@/libs/meta";
import { resolveRepoCwd } from "@/libs/repos";
import { BRIDGE_ROOT, SESSIONS_DIR, readBridgeMd } from "@/libs/paths";
import { guestBoundRepoValue } from "@/libs/guestSessionRepo";
import { createSseResponse } from "@/libs/sse";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ sessionId: string }> };

interface ReplayEntry {
  offset: number;
  line: unknown;
}
interface ReplayBuffer {
  endOffset: number;
  entries: ReplayEntry[];
}
const REPLAY_MAX = 500;
const DEBOUNCE_MS = 250;
const REPLAY_SESSIONS_MAX = 100;

const G = globalThis as unknown as { __bridgeTailReplay?: Map<string, ReplayBuffer> };
const replay: Map<string, ReplayBuffer> = G.__bridgeTailReplay ?? new Map();
G.__bridgeTailReplay = replay;

function getBuffer(key: string): ReplayBuffer {
  let b = replay.get(key);
  if (b) {
    replay.delete(key);
    replay.set(key, b);
    return b;
  }
  b = { endOffset: 0, entries: [] };
  replay.set(key, b);
  while (replay.size > REPLAY_SESSIONS_MAX) {
    const oldest = replay.keys().next().value;
    if (oldest === undefined) break;
    replay.delete(oldest);
  }
  return b;
}

function appendToBuffer(
  buf: ReplayBuffer,
  lines: unknown[],
  lineOffsets: number[],
  endOffset: number,
) {
  for (let i = 0; i < lines.length; i++) {
    buf.entries.push({ offset: lineOffsets[i] ?? buf.endOffset, line: lines[i] });
  }
  if (buf.entries.length > REPLAY_MAX) {
    buf.entries.splice(0, buf.entries.length - REPLAY_MAX);
  }
  buf.endOffset = endOffset;
}

function replayFrom(
  buf: ReplayBuffer,
  since: number,
): { lines: unknown[]; offset: number; lineOffsets: number[] } | null {
  if (buf.entries.length === 0) return null;
  if (since < buf.entries[0].offset) return null;
  const lines: unknown[] = [];
  const lineOffsets: number[] = [];
  for (const e of buf.entries) {
    if (e.offset < since) continue;
    lines.push(e.line);
    lineOffsets.push(e.offset);
  }
  return { lines, offset: buf.endOffset, lineOffsets };
}

export async function GET(req: NextRequest, ctx: Ctx) {
  const { sessionId } = await ctx.params;
  const { searchParams } = new URL(req.url);
  const repoPath = searchParams.get("repo");
  const since = Number(searchParams.get("since") ?? 0) || 0;

  const actor = verifyRequestActor(req);
  let effectiveRepoPath = repoPath;
  if (actor?.kind === "guest") {
    const ownerMeta = readMeta(join(SESSIONS_DIR, actor.taskId));
    const sessionRepo = ownerMeta?.runs.find((r) => r.sessionId === sessionId)?.repo ?? null;
    const sessionRepoPath = sessionRepo ? resolveRepoCwd(readBridgeMd(), BRIDGE_ROOT, sessionRepo) : null;
    effectiveRepoPath = guestBoundRepoValue({
      actorKind: "guest",
      callerValue: repoPath,
      sessionValue: sessionRepoPath,
    });
  }

  if (!isRegisteredRepoPath(effectiveRepoPath)) {
    return new Response("invalid session repo", { status: 400 });
  }
  const file = resolveSessionFile(effectiveRepoPath, sessionId);
  if (!file) {
    return new Response("invalid session repo", { status: 400 });
  }
  const releaseSlot = acquireSseSlot(req);
  if (!releaseSlot) {
    return new Response("too many concurrent streams", { status: 429 });
  }
  const bufferKey = `${effectiveRepoPath}::${sessionId}`;
  const buffer = getBuffer(bufferKey);

  return createSseResponse({
    signal: req.signal,
    keepaliveMs: 15000,
    onStart: (send) => {
      let closed = false;
      let offset = since;
      let pending: ReturnType<typeof setTimeout> | null = null;
      let inFlight = false;
      let watcher: FSWatcher | null = null;
      let waitTimer: ReturnType<typeof setTimeout> | null = null;
      let primed = false;

      const drain = async () => {
        if (closed || inFlight) return;
        inFlight = true;
        try {
          if (!existsSync(file)) return;
          const result = await tailJsonl(file, offset);
          if (closed) return;
          offset = result.offset;
          if (result.lines.length > 0) {
            appendToBuffer(buffer, result.lines, result.lineOffsets, result.offset);
          }
          if (result.lines.length > 0 || !primed) {
            primed = true;
            send("tail", result);
          }
        } catch {
        } finally {
          inFlight = false;
        }
      };

      const scheduleDrain = () => {
        if (pending) return;
        pending = setTimeout(() => {
          pending = null;
          void drain();
        }, DEBOUNCE_MS);
      };

      const startWatcher = () => {
        if (closed || watcher) return;
        try {
          watcher = watch(file, { persistent: false }, () => scheduleDrain());
          watcher.on("error", () => {
            try { watcher?.close(); } catch { }
            watcher = null;
            waitForFile();
          });
        } catch {
          watcher = null;
          waitForFile();
        }
      };

      const waitForFile = () => {
        if (closed || watcher) return;
        if (existsSync(file)) {
          startWatcher();
          void drain();
          return;
        }
        waitTimer = setTimeout(() => {
          if (closed) return;
          waitForFile();
        }, 2000);
      };

      const cached = since > 0 ? replayFrom(buffer, since) : null;
      if (cached) {
        offset = cached.offset;
        primed = true;
        send("tail", cached);
        void drain().then(() => {
          if (closed) return;
          if (existsSync(file)) startWatcher();
          else waitForFile();
        });
      } else {
        void drain().then(() => {
          if (closed) return;
          if (existsSync(file)) startWatcher();
          else waitForFile();
        });
      }

      send("alive", { alive: isAlive(sessionId) });
      const unsub = subscribeSession(sessionId, {
        onPartial: (p: PartialEvent) => send("partial", p),
        onAlive: (alive: boolean) => send("alive", { alive }),
        onStatus: (s: StatusEvent) => send("status", s),
      });

      return () => {
        closed = true;
        if (pending) { clearTimeout(pending); pending = null; }
        if (waitTimer) { clearTimeout(waitTimer); waitTimer = null; }
        try { unsub(); } catch { }
        try { watcher?.close(); } catch { }
        try { releaseSlot(); } catch { }
      };
    },
  });
}
