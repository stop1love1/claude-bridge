/**
 * Which sessions the operator has put in "skip permissions" mode.
 *
 * The child's `BRIDGE_AUTO_APPROVE` env var can only be set at spawn time, so
 * it cannot help a session that is already running — and it never existed for
 * an orphan session the bridge did not spawn. Recording the choice here lets
 * the permission route answer on the operator's behalf when the request
 * arrives, which is the only point both of those cases pass through.
 *
 * Deliberately in memory only: a bypass that survived a bridge restart would
 * keep auto-allowing tool calls the operator no longer has in mind. The
 * composer re-sends the mode with every message, so the flag comes back on the
 * next turn if it is still switched on.
 */
const G = globalThis as unknown as { __bridgeSessionBypass?: Set<string> };
const bypassed: Set<string> = G.__bridgeSessionBypass ?? new Set<string>();
G.__bridgeSessionBypass = bypassed;

export function setSessionBypass(sessionId: string, on: boolean): void {
  if (!sessionId) return;
  if (on) bypassed.add(sessionId);
  else bypassed.delete(sessionId);
}

export function isSessionBypassed(sessionId: string): boolean {
  if (!sessionId) return false;
  return bypassed.has(sessionId);
}

export function _resetSessionBypassForTests(): void {
  bypassed.clear();
}
