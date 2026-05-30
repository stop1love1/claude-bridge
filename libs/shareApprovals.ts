/**
 * In-memory store for pending **guest share-access** requests.
 *
 * Parallel to `libs/loginApprovals.ts`, but for the task-share flow:
 *
 *   1. A guest opens a share link and has no valid device grant yet.
 *      The access route creates a `PendingShareRequest` here with a
 *      freshly-minted candidate device id (`did`).
 *   2. The guest polls `GET /api/share/access/<id>/pending/<reqId>`.
 *   3. The operator's header approvals poll surfaces it; they Approve
 *      or Deny. Approve writes the candidate `did` into the share's
 *      device list (see `shareStore.addDevice`) and marks this entry
 *      `approved`.
 *   4. The guest's next poll sees `approved`, the route signs a scoped
 *      guest cookie bound to (shareId, taskId, did) and attaches it.
 *
 * Ephemeral by design — a pending request needn't survive a restart
 * (the guest just re-requests). Entries auto-expire after 3 minutes.
 * HMR-safe via the usual `globalThis` stash.
 */

import { randomBytes } from "node:crypto";

export interface PendingShareRequest {
  id: string;
  shareId: string;
  taskId: string;
  /** Candidate device id, written into the share on approval. */
  did: string;
  /** Display name the guest entered (already trimmed/capped). */
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

/** TTL for an unanswered request — 3 minutes. */
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
    // Keep answered entries a bit longer so the guest's poll can read
    // the final state before GC.
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

/** Drop an entry after its final state has been delivered to the guest. */
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

/** Test-only: clear the store. */
export function _resetForTests(): void {
  store.pending.clear();
}
