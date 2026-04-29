/**
 * Tiny per-key in-flight gate. Wraps a set of keys whose value is
 * "an op of this kind is currently running". Used by routes that
 * spawn coordinators / fire long-running side effects to dedup
 * button-mash ("continue", "clear", "spawn") so the user doesn't
 * end up with two coordinators for the same task.
 *
 * Pinned to globalThis so an HMR reload of the route's module doesn't
 * lose the in-flight set — same pattern as `__bridgeMetaWriteQueues`.
 *
 * Granularity is per (kind, key). Two different routes (`continue`,
 * `clear`) on the same task each get their own gate, but two
 * concurrent POSTs to the same route on the same task share one.
 */
type Gate = Set<string>;

const G = globalThis as unknown as {
  __bridgeInFlight?: Map<string, Gate>;
};
const gates: Map<string, Gate> =
  G.__bridgeInFlight ?? new Map<string, Gate>();
G.__bridgeInFlight = gates;

function getGate(kind: string): Gate {
  let g = gates.get(kind);
  if (!g) {
    g = new Set<string>();
    gates.set(kind, g);
  }
  return g;
}

/**
 * Run `fn` while the key is locked under `kind`. If another caller is
 * already inside the same (kind, key), this resolves to `null` —
 * caller responds with 409 / no-op rather than starting a duplicate
 * operation. The gate is released when `fn` settles (success or
 * throw) so a crashing op can't strand the gate.
 */
export async function withInFlight<T>(
  kind: string,
  key: string,
  fn: () => Promise<T>,
): Promise<T | null> {
  const gate = getGate(kind);
  if (gate.has(key)) return null;
  gate.add(key);
  try {
    return await fn();
  } finally {
    gate.delete(key);
  }
}

/** Test helper: peek whether (kind, key) is currently busy. */
export function isInFlight(kind: string, key: string): boolean {
  return gates.get(kind)?.has(key) === true;
}
