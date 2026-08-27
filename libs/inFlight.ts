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

export function isInFlight(kind: string, key: string): boolean {
  return gates.get(kind)?.has(key) === true;
}
