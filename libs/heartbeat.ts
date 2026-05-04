/**
 * In-memory heartbeat store. The PreToolUse permission hook fires a
 * fire-and-forget POST to `/api/sessions/<sid>/heartbeat` on every
 * tool boundary, regardless of permission mode (the hook is wired in
 * even for `bypassPermissions` children — they otherwise skip the
 * permission round-trip entirely). The endpoint records the timestamp
 * here and the stale-run reaper consults it as an "agent activity"
 * signal alongside JSONL mtime.
 *
 * Why in-memory and not on `meta.json`:
 *   - Persisting heartbeats to disk would mean a meta.json write on
 *     every tool use × every active run. A coordinator orchestrating
 *     three agents at ~20 tool calls / minute would push 60 writes /
 *     minute through the meta lock — pure overhead with no recovery
 *     value, since heartbeats are inherently ephemeral.
 *   - On bridge restart we lose every entry, but bridge restart also
 *     tree-kills bridge-spawned children (they exit alongside the
 *     parent), so the only runs that could SURVIVE a restart are the
 *     externally-spawned ones — and those have their own JSONL +
 *     OS-probe fallbacks in the reaper. The boot-sweep flips zombie
 *     entries on restart anyway.
 *
 * Stashed on `globalThis` so Next.js dev HMR doesn't lose the map
 * when an API route module reloads (same trick as `spawnRegistry`
 * and `permissionStore`).
 */

interface Store {
  /** sessionId → epoch-ms of the last heartbeat we received */
  beats: Map<string, number>;
}

const G = globalThis as unknown as { __bridgeHeartbeatStore?: Store };
const store: Store = G.__bridgeHeartbeatStore ?? { beats: new Map() };
G.__bridgeHeartbeatStore = store;

/**
 * Record a heartbeat for `sessionId`. Idempotent — overwrites the
 * previous timestamp. Called from the heartbeat endpoint and any
 * other "agent did something" code path the bridge owns.
 */
export function recordHeartbeat(sessionId: string): void {
  if (!sessionId) return;
  store.beats.set(sessionId, Date.now());
}

/**
 * Return the last heartbeat timestamp for `sessionId`, or `null` if
 * we never received one. Used by the reaper to decide whether the
 * agent has been visibly active recently.
 */
export function getLastHeartbeat(sessionId: string): number | null {
  return store.beats.get(sessionId) ?? null;
}

/**
 * Test helper — clear every heartbeat. The reaper tests use this in
 * `beforeEach` so a stale entry from a previous test can't trick a
 * later one into seeing fresh activity.
 */
export function _clearHeartbeatsForTest(): void {
  store.beats.clear();
}
