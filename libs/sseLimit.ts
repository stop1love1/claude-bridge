/**
 * Per-key cap on concurrent SSE connections.
 *
 * SSE endpoints (`/api/tasks/[id]/events`, `/api/sessions/[id]/tail/stream`,
 * `/api/permission/stream`, …) keep a long-lived TCP connection plus an
 * fs.watch + setInterval keepalive per client. Without a cap a buggy /
 * hostile browser script can open thousands of EventSource handles and
 * exhaust file descriptors, the per-process listener budget, or the
 * Next.js stream pool.
 *
 * Strategy: cheap in-process counter keyed by trusted-device id (when
 * the request carries an authed cookie with `did`), falling back to the
 * authed email (`sub`), then to the raw client IP (`unknown` if the
 * proxy header isn't trusted). Stashed on `globalThis` so HMR doesn't
 * drop counts mid-session.
 *
 * `acquireSseSlot` returns either a `release()` callback (slot granted)
 * or `null` (over the cap — caller should respond 429). The release MUST
 * be called from the SSE close handler.
 */
import type { NextRequest } from "next/server";
import { COOKIE_NAME, verifyRequestAuth } from "./auth";
import { getClientIp } from "./clientIp";

/**
 * Per-key concurrent connection cap. 50 covers the realistic UI ceiling
 * (a power user might keep tasks/sessions/agents/permission streams open
 * across multiple tabs) without letting a runaway script drain FDs.
 */
const SSE_CAP_PER_KEY = 50;

type Counters = Map<string, number>;

const G = globalThis as unknown as { __bridgeSseCounts?: Counters };
const counts: Counters = G.__bridgeSseCounts ?? new Map();
G.__bridgeSseCounts = counts;

function keyFor(req: NextRequest): string {
  const payload = verifyRequestAuth(req);
  if (payload?.did) return `did:${payload.did}`;
  if (payload?.sub) return `sub:${payload.sub}`;
  // Anonymous fallback — no auth on the request. The route's own auth
  // gate (proxy / per-route check) will usually 401 first; this branch
  // exists purely so the helper can't crash on an edge case.
  const cookie = req.cookies.get(COOKIE_NAME)?.value;
  if (cookie) return `cookie:${cookie.slice(0, 32)}`;
  return `ip:${getClientIp(req.headers)}`;
}

export function acquireSseSlot(req: NextRequest): (() => void) | null {
  const key = keyFor(req);
  const current = counts.get(key) ?? 0;
  if (current >= SSE_CAP_PER_KEY) return null;
  counts.set(key, current + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const next = (counts.get(key) ?? 1) - 1;
    if (next <= 0) counts.delete(key);
    else counts.set(key, next);
  };
}

/** Test-only helper. */
export function _resetSseCounts(): void {
  counts.clear();
}

export const SSE_CAP_FOR_TESTS = SSE_CAP_PER_KEY;
