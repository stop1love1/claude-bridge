type Bust = () => void;
const G = globalThis as unknown as { __bridgeBustSessionsAll?: Bust };

export function setSessionsListBuster(fn: Bust): void {
  G.__bridgeBustSessionsAll = fn;
}

export function bustSessionsListCache(): void {
  G.__bridgeBustSessionsAll?.();
}
