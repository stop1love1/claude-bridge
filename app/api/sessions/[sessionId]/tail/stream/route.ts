import type { NextRequest } from "next/server";
import { existsSync, watch, type FSWatcher } from "node:fs";
import { join } from "node:path";
import { projectDirFor, tailJsonl } from "@/libs/sessions";
import { isAlive, subscribeSession, type PartialEvent, type StatusEvent } from "@/libs/sessionEvents";
import { isValidSessionId } from "@/libs/validate";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ sessionId: string }> };

/**
 * In-process replay buffer per `<repoPath>::<sessionId>`. Holds the
 * last N parsed lines (with their byte offsets) so a reconnecting
 * client passing `?since=<offset>` gets the gap served from memory
 * instead of re-reading the file. Without this, every reconnect
 * triggers a full disk read up to EOF on a potentially-large jsonl.
 *
 * Stashed on `globalThis` so Next.js dev HMR doesn't drop the cache
 * across module reloads. Same trick as `spawnRegistry` / `permissionStore`.
 */
interface ReplayEntry {
  /** Byte offset where this line BEGINS in the .jsonl (parallel to `lineOffsets`). */
  offset: number;
  line: unknown;
}
interface ReplayBuffer {
  /** EOF byte offset reached by the last drain — also the next `since` cursor. */
  endOffset: number;
  /** Newest-last; capped at REPLAY_MAX. */
  entries: ReplayEntry[];
}
const REPLAY_MAX = 500;
const DEBOUNCE_MS = 250;
// Cap how many sessions are tracked in the replay map. Without this,
// every session ever opened lives in `globalThis` until the process
// restarts — a long-lived bridge with thousands of sessions slowly
// accumulates ~500 entries × 1 KiB each per session in heap.
const REPLAY_SESSIONS_MAX = 100;

const G = globalThis as unknown as { __bridgeTailReplay?: Map<string, ReplayBuffer> };
const replay: Map<string, ReplayBuffer> = G.__bridgeTailReplay ?? new Map();
G.__bridgeTailReplay = replay;

function getBuffer(key: string): ReplayBuffer {
  let b = replay.get(key);
  if (b) {
    // LRU touch: re-insert so the most-recently-used keys live at the
    // tail of the iteration order. Map preserves insertion order, so
    // delete + set is the canonical cheap LRU bump.
    replay.delete(key);
    replay.set(key, b);
    return b;
  }
  b = { endOffset: 0, entries: [] };
  replay.set(key, b);
  // Evict the oldest entries until we're back under the cap.
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

/**
 * Slice the buffer for entries at-or-after `since`. Returns `null`
 * when `since` is older than the oldest cached offset (cache miss —
 * the caller should fall back to reading the file).
 */
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

/**
 * Streaming tail for a Claude session `.jsonl`. Replaces the polling
 * loop that called `/api/sessions/<id>/tail` every 1–30s with a single
 * SSE connection driven by `fs.watch`.
 *
 * Wire format (mirrors the REST tail response, plus two live channels):
 *   - `event: tail`     data: { lines, offset, lineOffsets }
 *   - `event: partial`  data: { messageId, index, text }
 *                          → assistant text deltas streamed by claude
 *                            (`--include-partial-messages`). Lets the
 *                            UI render the reply token-by-token before
 *                            the canonical `tail` line lands.
 *   - `event: alive`    data: { alive: boolean }
 *                          → process lifecycle. Emitted on connect with
 *                            the current registry state, then again
 *                            whenever a child spawns/exits for this
 *                            session. The Stop button uses this so it
 *                            stays visible across long tool calls.
 *   - `event: status`   data: { kind, label? }
 *                          → activity indicator above the composer.
 *                            "thinking" while the API is responding,
 *                            "running" with a tool description while a
 *                            Bash / tool / sub-task executes, "idle"
 *                            on message_stop / child exit.
 *
 * Initial connect emits one `tail` event with everything from `since`
 * to current EOF (so the client can populate without a separate REST
 * call). After that, every file mutation re-reads from the last known
 * offset and pushes a fresh `tail` event with only the new lines.
 *
 * Backward paging (`/tail?before=…`) stays REST — it's user-driven,
 * not a stream. fs.watch can be wonky on some platforms (e.g. network
 * drives, WSL→Windows mounts); the client should still keep a slow
 * polling fallback as a safety net.
 */
export async function GET(req: NextRequest, ctx: Ctx) {
  const { sessionId } = await ctx.params;
  if (!isValidSessionId(sessionId)) {
    return new Response("invalid sessionId", { status: 400 });
  }
  const { searchParams } = new URL(req.url);
  const repoPath = searchParams.get("repo");
  const since = Number(searchParams.get("since") ?? 0) || 0;

  if (!repoPath) {
    return new Response("repo query param required", { status: 400 });
  }
  const file = join(projectDirFor(repoPath), `${sessionId}.jsonl`);
  const bufferKey = `${repoPath}::${sessionId}`;
  const buffer = getBuffer(bufferKey);

  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    start(controller) {
      let closed = false;
      let offset = since;
      // fs.watch fires multiple events per write on some platforms; a
      // small debounce coalesces a burst of `change` events into one
      // tailJsonl read. Long enough (250ms) that a model streaming
      // tokens fast still produces ~4 events/sec, short enough that
      // the latency cost is invisible to humans. Without this we'd
      // spam reads on every chunk claude flushes to disk.
      let pending: ReturnType<typeof setTimeout> | null = null;
      let inFlight = false;
      let watcher: FSWatcher | null = null;
      let waitTimer: ReturnType<typeof setTimeout> | null = null;
      let primed = false;

      const send = (event: string, data: unknown) => {
        if (closed) return;
        try {
          controller.enqueue(
            encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
          );
        } catch {
          /* client disconnected mid-write */
        }
      };

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
          // Always emit (even with 0 lines) on the first call so the
          // client knows the connection is live and gets the current
          // offset cursor; afterwards skip empty drains to keep the
          // stream quiet.
          if (result.lines.length > 0 || !primed) {
            primed = true;
            send("tail", result);
          }
        } catch {
          /* file vanished mid-read; next watcher tick will retry */
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
            // fs.watch can die on file rename / EPERM on Windows when
            // the writer flips the file. Tear it down and let the
            // wait-for-file loop spin it back up if/when the file
            // reappears.
            try { watcher?.close(); } catch { /* ignore */ }
            watcher = null;
            waitForFile();
          });
        } catch {
          watcher = null;
          waitForFile();
        }
      };

      // If the .jsonl doesn't exist yet (session was registered but the
      // first claude write hasn't landed), poll every 2s for it to
      // appear, then promote to fs.watch.
      const waitForFile = () => {
        if (closed || watcher) return;
        if (existsSync(file)) {
          startWatcher();
          void drain();
          return;
        }
        waitTimer = setTimeout(waitForFile, 2000);
      };

      // Replay-buffer fast path: if the cached endOffset is past the
      // client's `since`, we can serve the gap from memory and skip
      // the disk read. Cache misses (since older than oldest entry)
      // fall through to a normal drain.
      const cached = since > 0 ? replayFrom(buffer, since) : null;
      if (cached) {
        offset = cached.offset;
        primed = true;
        send("tail", cached);
        // Still drain once to catch anything written between the buffer's
        // endOffset and the file's actual EOF (e.g. a very recent write
        // that hasn't fired the watcher yet).
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

      const ka = setInterval(() => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`: keepalive\n\n`));
        } catch {
          /* ignore */
        }
      }, 15000);

      // Live channels: partial text deltas + process alive state. The
      // pub/sub is global (per session id) — every connected SSE client
      // receives the same fan-out.
      send("alive", { alive: isAlive(sessionId) });
      const unsub = subscribeSession(sessionId, {
        onPartial: (p: PartialEvent) => send("partial", p),
        onAlive: (alive: boolean) => send("alive", { alive }),
        onStatus: (s: StatusEvent) => send("status", s),
      });

      const close = () => {
        if (closed) return;
        closed = true;
        if (pending) clearTimeout(pending);
        if (waitTimer) clearTimeout(waitTimer);
        clearInterval(ka);
        try { unsub(); } catch { /* ignore */ }
        try { watcher?.close(); } catch { /* ignore */ }
        try { controller.close(); } catch { /* already closed */ }
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
