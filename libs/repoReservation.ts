interface Reservation {
  sessionId: string;
}

interface ReservationStore {
  byRepo: Map<string, Reservation>;
}

const G = globalThis as unknown as { __bridgeRepoReservations?: ReservationStore };
const store: ReservationStore = G.__bridgeRepoReservations ?? { byRepo: new Map() };
G.__bridgeRepoReservations = store;

export interface AcquireRepoReservationResult {
  ok: boolean;
  heldBy?: string;
}

export function acquireRepoReservation(
  repo: string,
  sessionId: string,
): AcquireRepoReservationResult {
  const current = store.byRepo.get(repo);
  if (!current || current.sessionId === sessionId) {
    store.byRepo.set(repo, { sessionId });
    return { ok: true };
  }
  return { ok: false, heldBy: current.sessionId };
}

export interface TransferRepoReservationResult {
  ok: boolean;
  heldBy?: string;
}

export function transferRepoReservation(
  repo: string,
  fromSessionId: string,
  toSessionId: string,
): TransferRepoReservationResult {
  const current = store.byRepo.get(repo);
  if (!current || current.sessionId === fromSessionId) {
    store.byRepo.set(repo, { sessionId: toSessionId });
    return { ok: true };
  }
  return { ok: false, heldBy: current.sessionId };
}

export function releaseRepoReservation(repo: string, sessionId: string): void {
  const current = store.byRepo.get(repo);
  if (current && current.sessionId === sessionId) {
    store.byRepo.delete(repo);
  }
}

export function currentReservation(repo: string): Reservation | null {
  return store.byRepo.get(repo) ?? null;
}
