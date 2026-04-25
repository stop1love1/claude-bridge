import { EventEmitter } from "node:events";

/**
 * Module-level, in-memory store for PreToolUse permission requests
 * surfaced from the claude hook script. Survives across Next.js API
 * route invocations because the dev / prod server keeps the module
 * cached. NOT persisted to disk — these are ephemeral by design (a
 * server restart drops every pending request, which times out the
 * hook, which fails open and lets claude proceed).
 */

export type PendingStatus = "pending" | "allow" | "deny";

export interface PendingRequest {
  sessionId: string;
  requestId: string;
  tool: string;
  input: unknown;
  status: PendingStatus;
  reason?: string;
  createdAt: string;
}

interface Store {
  pending: Map<string, PendingRequest>; // key = `${sessionId}:${requestId}`
  emitters: Map<string, EventEmitter>;  // key = sessionId
  /**
   * Phase C: a single fan-out emitter that fires for every session.
   * The global PermissionDialog (mounted on every page) subscribes here
   * so it sees pending tool requests across all running sessions, even
   * ones the user is not currently watching.
   */
  globalEmitter: EventEmitter;
}

// Stash on globalThis so HMR module reload in dev doesn't blow away
// in-flight requests. Cast through unknown to avoid leaking the type
// into global scope for downstream consumers.
const G = globalThis as unknown as { __bridgePermissionStore?: Store };
const store: Store = G.__bridgePermissionStore ?? {
  pending: new Map(),
  emitters: new Map(),
  globalEmitter: (() => { const e = new EventEmitter(); e.setMaxListeners(0); return e; })(),
};
// Backfill globalEmitter for an HMR reload of an older module instance.
if (!store.globalEmitter) {
  const e = new EventEmitter();
  e.setMaxListeners(0);
  store.globalEmitter = e;
}
G.__bridgePermissionStore = store;

function key(sessionId: string, requestId: string): string {
  return `${sessionId}:${requestId}`;
}

function emitterFor(sessionId: string): EventEmitter {
  let e = store.emitters.get(sessionId);
  if (!e) {
    e = new EventEmitter();
    e.setMaxListeners(0);
    store.emitters.set(sessionId, e);
  }
  return e;
}

export function announcePending(req: Omit<PendingRequest, "status">): PendingRequest {
  const full: PendingRequest = { ...req, status: "pending" };
  store.pending.set(key(req.sessionId, req.requestId), full);
  emitterFor(req.sessionId).emit("pending", full);
  store.globalEmitter.emit("pending", full);
  return full;
}

export function getPending(sessionId: string, requestId: string): PendingRequest | undefined {
  return store.pending.get(key(sessionId, requestId));
}

export function listPending(sessionId: string): PendingRequest[] {
  const out: PendingRequest[] = [];
  for (const v of store.pending.values()) {
    if (v.sessionId === sessionId && v.status === "pending") out.push(v);
  }
  return out;
}

/** Phase C: every still-pending request, across every session. */
export function listAllPending(): PendingRequest[] {
  const out: PendingRequest[] = [];
  for (const v of store.pending.values()) {
    if (v.status === "pending") out.push(v);
  }
  return out;
}

/** Mark a request answered. Returns the updated record, or null if absent. */
export function answer(
  sessionId: string,
  requestId: string,
  decision: "allow" | "deny",
  reason?: string,
): PendingRequest | null {
  const k = key(sessionId, requestId);
  const cur = store.pending.get(k);
  if (!cur) return null;
  cur.status = decision;
  cur.reason = reason;
  store.pending.set(k, cur);
  emitterFor(sessionId).emit("answered", cur);
  store.globalEmitter.emit("answered", cur);
  return cur;
}

/**
 * Drop a request from the store. Called by the hook's poll handler
 * after it has read the final answer — keeps the map from leaking.
 */
export function consume(sessionId: string, requestId: string): void {
  store.pending.delete(key(sessionId, requestId));
}

export function subscribe(
  sessionId: string,
  onPending: (r: PendingRequest) => void,
  onAnswered?: (r: PendingRequest) => void,
): () => void {
  const e = emitterFor(sessionId);
  e.on("pending", onPending);
  if (onAnswered) e.on("answered", onAnswered);
  return () => {
    e.off("pending", onPending);
    if (onAnswered) e.off("answered", onAnswered);
  };
}

/**
 * Phase C: subscribe to pending / answered events for ANY session. The
 * global PermissionDialog uses this so a popup pops in whichever page
 * the user happens to be on, not just the one watching the originating
 * session.
 */
export function subscribeAll(
  onPending: (r: PendingRequest) => void,
  onAnswered?: (r: PendingRequest) => void,
): () => void {
  store.globalEmitter.on("pending", onPending);
  if (onAnswered) store.globalEmitter.on("answered", onAnswered);
  return () => {
    store.globalEmitter.off("pending", onPending);
    if (onAnswered) store.globalEmitter.off("answered", onAnswered);
  };
}
