
interface Store {
  beats: Map<string, number>;
}

const G = globalThis as unknown as { __bridgeHeartbeatStore?: Store };
const store: Store = G.__bridgeHeartbeatStore ?? { beats: new Map() };
G.__bridgeHeartbeatStore = store;

const HEARTBEAT_MAX_ENTRIES = 2000;
const HEARTBEAT_TTL_MS = 2 * 60 * 60 * 1000;

export function recordHeartbeat(sessionId: string): void {
  if (!sessionId) return;
  const now = Date.now();
  if (store.beats.size >= HEARTBEAT_MAX_ENTRIES) {
    const cutoff = now - HEARTBEAT_TTL_MS;
    for (const [sid, ts] of store.beats) {
      if (ts < cutoff) store.beats.delete(sid);
    }
  }
  store.beats.set(sessionId, now);
}

export function getLastHeartbeat(sessionId: string): number | null {
  return store.beats.get(sessionId) ?? null;
}

export function _clearHeartbeatsForTest(): void {
  store.beats.clear();
}
