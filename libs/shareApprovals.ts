
import { randomBytes } from "node:crypto";

export interface PendingShareRequest {
  id: string;
  shareId: string;
  taskId: string;
  did: string;
  displayName: string;
  ip: string;
  userAgent: string;
  createdAt: string;
  expiresAt: number;
  status: "pending" | "approved" | "denied";
  reason?: string;
}

interface Store {
  pending: Map<string, PendingShareRequest>;
}

const G = globalThis as unknown as { __bridgeShareApprovals?: Store };
const store: Store =
  G.__bridgeShareApprovals ?? { pending: new Map<string, PendingShareRequest>() };
G.__bridgeShareApprovals = store;

export const SHARE_APPROVAL_TTL_MS = 3 * 60 * 1000;

function newId(prefix: string): string {
  return `${prefix}_${randomBytes(8).toString("hex")}`;
}

function pruneExpired(now: number): void {
  for (const [id, e] of store.pending) {
    if (e.status === "pending" && e.expiresAt <= now) {
      store.pending.delete(id);
      continue;
    }
    if (e.status !== "pending" && e.expiresAt + 2 * 60 * 1000 <= now) {
      store.pending.delete(id);
    }
  }
}

export function createShareRequest(args: {
  shareId: string;
  taskId: string;
  displayName: string;
  ip: string;
  userAgent: string;
}): PendingShareRequest {
  const now = Date.now();
  pruneExpired(now);
  const entry: PendingShareRequest = {
    id: newId("sreq"),
    shareId: args.shareId,
    taskId: args.taskId,
    did: newId("gdv"),
    displayName: args.displayName.slice(0, 80),
    ip: args.ip,
    userAgent: args.userAgent.slice(0, 400),
    createdAt: new Date(now).toISOString(),
    expiresAt: now + SHARE_APPROVAL_TTL_MS,
    status: "pending",
  };
  store.pending.set(entry.id, entry);
  return entry;
}

export function getShareRequest(id: string): PendingShareRequest | null {
  pruneExpired(Date.now());
  return store.pending.get(id) ?? null;
}

export function answerShareRequest(
  id: string,
  decision: "approved" | "denied",
  reason?: string,
): PendingShareRequest | null {
  pruneExpired(Date.now());
  const entry = store.pending.get(id);
  if (!entry) return null;
  if (entry.status !== "pending") return entry;
  entry.status = decision;
  if (reason) entry.reason = reason.slice(0, 200);
  store.pending.set(id, entry);
  return entry;
}

export function consumeShareRequest(id: string): void {
  store.pending.delete(id);
}

export function listPendingShareRequests(): PendingShareRequest[] {
  pruneExpired(Date.now());
  const out: PendingShareRequest[] = [];
  for (const e of store.pending.values()) {
    if (e.status === "pending") out.push(e);
  }
  out.sort((a, b) => b.expiresAt - a.expiresAt);
  return out;
}

export function _resetForTests(): void {
  store.pending.clear();
}
