import type { NextRequest } from "next/server";
import { COOKIE_NAME, verifyRequestAuth } from "./auth";
import { getClientIp } from "./clientIp";

const SSE_CAP_PER_KEY = 50;

type Counters = Map<string, number>;

const G = globalThis as unknown as { __bridgeSseCounts?: Counters };
const counts: Counters = G.__bridgeSseCounts ?? new Map();
G.__bridgeSseCounts = counts;

function keyFor(req: NextRequest): string {
  const payload = verifyRequestAuth(req);
  if (payload?.did) return `did:${payload.did}`;
  if (payload?.sub) return `sub:${payload.sub}`;
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

export function _resetSseCounts(): void {
  counts.clear();
}

export const SSE_CAP_FOR_TESTS = SSE_CAP_PER_KEY;
